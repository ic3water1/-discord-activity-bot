// commands/testweek.js
const { SlashCommandBuilder, PermissionsBitField, MessageFlags } = require('discord.js');

// Constants (ideally shared)
const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SUB_HEADERS = [
    'Player Display Name', 'Screenshot', 'Timestamp (UTC)',
    'Verified', 'Strikes', 'Time in Server', 'Drive File ID'
];
const ROWS_PER_DAY_BLOCK = 1 + DAY_SUB_HEADERS.length;
const DRIVE_FILE_ID_SUB_HEADER_INDEX = DAY_SUB_HEADERS.indexOf('Drive File ID');

async function commandReplyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) {
    // ... (same helper function)
    try {
        let sentMessage;
        const currentOptions = { ...options, flags: [MessageFlags.Ephemeral] };
        if (isEdit) sentMessage = await interaction.editReply(currentOptions);
        else if (isFollowUp) sentMessage = await interaction.followUp(currentOptions);
        else sentMessage = await interaction.reply(currentOptions);

        if (sentMessage && typeof sentMessage.delete === 'function') {
            setTimeout(() => {
                sentMessage.delete().catch(err => {
                    if (err.code !== 10008) console.error(`[AUTO_DELETE_ERROR] Ephemeral cmd reply ${sentMessage.id || 'unknown'}:`, err.message);
                });
            }, 10000); // 10 seconds
        }
    } catch (error) {
        console.error(`[CMD_REPLY_ERROR] Failed to send or handle ephemeral auto-delete reply:`, error.message);
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('testweek')
        .setDescription('TEST CMD: Marks all days green, clears all weekly data, and deletes Drive screenshots after 15s.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .setDMPermission(false),

    async execute(interaction, client, guildConfigs, saveGuildConfigs, _clearSheetFunction, _replyHelper, sheetsClient, driveClient, SPREADSHEET_ID, SHEET_NAME, numericSheetId) {
        const currentReplyHelper = typeof _replyHelper === 'function' ? _replyHelper : commandReplyEphemeralAutoDelete;

        if (!interaction.inGuild() || !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            currentReplyHelper(interaction, { content: 'This command is for administrators only and must be used in a server.' });
            return;
        }
        if (!sheetsClient || !driveClient || !SPREADSHEET_ID || !SHEET_NAME || typeof numericSheetId === 'undefined') {
            currentReplyHelper(interaction, { content: 'Google Sheets/Drive integration is not ready. Cannot perform /testweek.' });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const driveFileIdsToClear = [];
            const batchUpdateRequests = [];
            const rangesToClearData = [];

            for (let i = 0; i < DAYS_OF_WEEK.length; i++) {
                const dayName = DAYS_OF_WEEK[i];
                const dayHeaderRowIndex = (i * ROWS_PER_DAY_BLOCK) + 1;
                const startDataRowForDay = dayHeaderRowIndex + 1;
                const endDataRowForDay = startDataRowForDay + DAY_SUB_HEADERS.length - 1;
                const driveFileIdCellRow = startDataRowForDay + DRIVE_FILE_ID_SUB_HEADER_INDEX;

                // 1. Prepare to get Drive File ID for the current day
                try {
                    const getResponse = await sheetsClient.spreadsheets.values.get({
                        spreadsheetId: SPREADSHEET_ID,
                        range: `'${SHEET_NAME}'!B${driveFileIdCellRow}`,
                    });
                    if (getResponse.data.values && getResponse.data.values[0] && getResponse.data.values[0][0]) {
                        driveFileIdsToClear.push(getResponse.data.values[0][0]);
                    }
                } catch (err) {
                    console.warn(`[TESTWEEK_WARN] Could not read Drive File ID for ${dayName}: ${err.message}`);
                }

                // 2. Prepare batch update requests
                // Clear data cells for the day
                rangesToClearData.push(`'${SHEET_NAME}'!B${startDataRowForDay}:B${endDataRowForDay}`);
                
                // Format day header cell to green
                batchUpdateRequests.push({
                    updateCells: {
                        range: {
                            sheetId: numericSheetId,
                            startRowIndex: dayHeaderRowIndex - 1, // API is 0-indexed
                            endRowIndex: dayHeaderRowIndex,
                            startColumnIndex: 0, // Column A
                            endColumnIndex: 1,   // Only Column A
                        },
                        rows: [{ values: [{ userEnteredFormat: { backgroundColorStyle: { rgbColor: { green: 0.7, red: 0.3, blue: 0.3 } } } }] }],
                        fields: "userEnteredFormat.backgroundColorStyle"
                    }
                });
            }

            // Execute batch clear for data first
            if (rangesToClearData.length > 0) {
                await sheetsClient.spreadsheets.values.batchClear({
                    spreadsheetId: SPREADSHEET_ID,
                    resource: { ranges: rangesToClearData }
                });
            }
            // Then execute batch update for formatting
            if (batchUpdateRequests.length > 0) {
                 await sheetsClient.spreadsheets.batchUpdate({
                    spreadsheetId: SPREADSHEET_ID,
                    resource: { requests: batchUpdateRequests }
                });
            }

            console.log(`[TESTWEEK] Marked all days green and cleared weekly data in Column B.`);
            currentReplyHelper(interaction, { content: `All days marked green, weekly data slots cleared. Associated Drive files (${driveFileIdsToClear.length} found) will be deleted in 15 seconds.` }, false, true);

            // 3. After 15 seconds, delete from Drive
            if (driveFileIdsToClear.length > 0) {
                setTimeout(async () => {
                    console.log(`[TESTWEEK_DRIVE_DELETE] Attempting to delete ${driveFileIdsToClear.length} Drive files.`);
                    for (const fileId of driveFileIdsToClear) {
                        try {
                            await driveClient.files.delete({ fileId: fileId });
                            console.log(`[TESTWEEK_DRIVE_DELETE] Successfully deleted Drive file ${fileId}.`);
                        } catch (driveError) {
                            console.error(`[TESTWEEK_DRIVE_DELETE_ERROR] Failed to delete Drive file ${fileId}: ${driveError.message}`);
                        }
                    }
                }, 15000); // 15 seconds
            } else {
                console.log(`[TESTWEEK_DRIVE_DELETE] No Drive File IDs found to delete.`);
            }

        } catch (error) {
            console.error('[TESTWEEK_ERROR] Error executing /testweek command:', error);
            currentReplyHelper(interaction, { content: 'An error occurred while executing /testweek. Check console.' }, false, true);
        }
    },
};
