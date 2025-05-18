// commands/testday.js
const { SlashCommandBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const { google } = require('googleapis'); // Required for color formatting

// Constants that would ideally be shared or passed from index.js if more complex
const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SUB_HEADERS = [
    'Player Display Name', 'Screenshot', 'Timestamp (UTC)',
    'Verified', 'Strikes', 'Time in Server', 'Drive File ID'
];
const ROWS_PER_DAY_BLOCK = 1 + DAY_SUB_HEADERS.length;
const DRIVE_FILE_ID_SUB_HEADER_INDEX = DAY_SUB_HEADERS.indexOf('Drive File ID');


async function commandReplyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) {
    // ... (same helper function as in other command files)
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
        .setName('testday')
        .setDescription('TEST CMD: Marks current day green, clears its data, and deletes its Drive screenshot after 15s.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .setDMPermission(false),

    async execute(interaction, client, guildConfigs, saveGuildConfigs, _clearSheetFunction, _replyHelper, sheetsClient, driveClient, SPREADSHEET_ID, SHEET_NAME, numericSheetId) {
        const currentReplyHelper = typeof _replyHelper === 'function' ? _replyHelper : commandReplyEphemeralAutoDelete;

        if (!interaction.inGuild() || !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            currentReplyHelper(interaction, { content: 'This command is for administrators only and must be used in a server.' });
            return;
        }
        if (!sheetsClient || !driveClient || !SPREADSHEET_ID || !SHEET_NAME || typeof numericSheetId === 'undefined') {
            currentReplyHelper(interaction, { content: 'Google Sheets/Drive integration is not ready. Cannot perform /testday.' });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const currentDate = new Date();
            const currentDayIndex = currentDate.getUTCDay(); // 0 for Sunday, 1 for Monday...
            const currentDayName = DAYS_OF_WEEK[currentDayIndex];

            const dayHeaderRowIndex = (currentDayIndex * ROWS_PER_DAY_BLOCK) + 1; // 1-based index for Sheets
            const startDataRowForDay = dayHeaderRowIndex + 1;
            const endDataRowForDay = startDataRowForDay + DAY_SUB_HEADERS.length - 1;
            const driveFileIdCellRow = startDataRowForDay + DRIVE_FILE_ID_SUB_HEADER_INDEX;

            // 1. Get Drive File ID for the current day
            let driveFileIdToClear = null;
            try {
                const getResponse = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `'${SHEET_NAME}'!B${driveFileIdCellRow}`,
                });
                if (getResponse.data.values && getResponse.data.values[0] && getResponse.data.values[0][0]) {
                    driveFileIdToClear = getResponse.data.values[0][0];
                }
            } catch (err) {
                console.warn(`[TESTDAY_WARN] Could not read Drive File ID for ${currentDayName}: ${err.message}`);
            }

            // 2. Batch update: Clear data cells & format day header to green
            const requests = [
                { // Clear data cells
                    updateCells: {
                        range: {
                            sheetId: numericSheetId,
                            startRowIndex: startDataRowForDay - 1, // API is 0-indexed
                            endRowIndex: endDataRowForDay,
                            startColumnIndex: 1, // Column B
                            endColumnIndex: 2,   // Only Column B
                        },
                        rows: Array(DAY_SUB_HEADERS.length).fill({ values: [{ userEnteredValue: { stringValue: "" } }] }),
                        fields: "userEnteredValue"
                    }
                },
                { // Format day header cell to green
                    updateCells: {
                        range: {
                            sheetId: numericSheetId,
                            startRowIndex: dayHeaderRowIndex - 1, // API is 0-indexed
                            endRowIndex: dayHeaderRowIndex,
                            startColumnIndex: 0, // Column A
                            endColumnIndex: 1,   // Only Column A
                        },
                        rows: [{
                            values: [{
                                userEnteredFormat: {
                                    backgroundColorStyle: { rgbColor: { green: 0.7, red: 0.3, blue: 0.3 } } // A light green
                                }
                            }]
                        }],
                        fields: "userEnteredFormat.backgroundColorStyle"
                    }
                }
            ];

            await sheetsClient.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: { requests }
            });
            console.log(`[TESTDAY] Marked ${currentDayName} green and cleared its data in Column B.`);
            currentReplyHelper(interaction, { content: `${currentDayName}'s data slot has been cleared and marked green. Associated Drive file (if any) will be deleted in 15 seconds.` }, false, true);

            // 3. After 15 seconds, delete from Drive
            if (driveFileIdToClear) {
                setTimeout(async () => {
                    try {
                        console.log(`[TESTDAY_DRIVE_DELETE] Attempting to delete Drive File ID: ${driveFileIdToClear} for ${currentDayName}.`);
                        await driveClient.files.delete({ fileId: driveFileIdToClear });
                        console.log(`[TESTDAY_DRIVE_DELETE] Successfully deleted Drive file ${driveFileIdToClear}.`);
                    } catch (driveError) {
                        console.error(`[TESTDAY_DRIVE_DELETE_ERROR] Failed to delete Drive file ${driveFileIdToClear}: ${driveError.message}`);
                    }
                }, 15000); // 15 seconds
            } else {
                console.log(`[TESTDAY_DRIVE_DELETE] No Drive File ID found for ${currentDayName} to delete.`);
            }

        } catch (error) {
            console.error('[TESTDAY_ERROR] Error executing /testday command:', error);
            currentReplyHelper(interaction, { content: 'An error occurred while executing /testday. Check console.' }, false, true);
        }
    },
};
