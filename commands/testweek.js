// commands/testweek.js
const { SlashCommandBuilder, PermissionsBitField, MessageFlags } = require('discord.js');

// Constants (ensure these match index.js or are passed/imported if centralized)
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
        .setName('testweek')
        .setDescription('TEST CMD: Marks all days green, clears weekly data, and deletes Drive screenshots after 15s.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .setDMPermission(false),

    async execute(interaction, client, guildConfigs, saveGuildConfigs, _clearSheetFunction, replyHelper, sheetsClient, driveClient, SPREADSHEET_ID, SHEET_NAME, numericSheetId) {
        console.log(`[TESTWEEK_CMD] Initiated by ${interaction.user.tag}`);

        if (!interaction.inGuild() || !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            replyHelper(interaction, { content: 'This command is for administrators only and must be used in a server.' });
            return;
        }
        if (!sheetsClient || !driveClient || !SPREADSHEET_ID || !SHEET_NAME || typeof numericSheetId === 'undefined') {
            replyHelper(interaction, { content: 'Google Sheets/Drive integration is not ready. Cannot perform /testweek.' });
            return;
        }

        try {
            console.log(`[TESTWEEK_CMD] Attempting to defer reply.`);
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); // Use flags
            console.log(`[TESTWEEK_CMD] Reply deferred successfully.`);

            const driveFileIdsToClear = [];
            const batchUpdateRequestsForFormatting = [];
            const rangesToClearDataInSheet = [];

            for (let i = 0; i < DAYS_OF_WEEK.length; i++) {
                const dayName = DAYS_OF_WEEK[i];
                const dayHeaderRowIndex = (i * ROWS_PER_DAY_BLOCK) + 1;
                const startDataRowForDay = dayHeaderRowIndex + 1;
                const endDataRowForDay = startDataRowForDay + DAY_SUB_HEADERS.length - 1;
                const driveFileIdCellRow = startDataRowForDay + DRIVE_FILE_ID_SUB_HEADER_INDEX;

                try {
                    const getResponse = await sheetsClient.spreadsheets.values.get({
                        spreadsheetId: SPREADSHEET_ID,
                        range: `'${SHEET_NAME}'!B${driveFileIdCellRow}`, // Drive File ID is in Column B
                    });
                    if (getResponse.data.values?.[0]?.[0]) {
                        driveFileIdsToClear.push(getResponse.data.values[0][0]);
                    }
                } catch (err) { console.warn(`[TESTWEEK_WARN] No Drive File ID for ${dayName}: ${err.message}`); }
                
                rangesToClearDataInSheet.push(`'${SHEET_NAME}'!B${startDataRowForDay}:B${endDataRowForDay}`);
                batchUpdateRequestsForFormatting.push({
                    updateCells: {
                        range: { sheetId: numericSheetId, startRowIndex: dayHeaderRowIndex - 1, endRowIndex: dayHeaderRowIndex, startColumnIndex: 0, endColumnIndex: 1 },
                        rows: [{ values: [{ userEnteredFormat: { backgroundColorStyle: { rgbColor: { green: 0.7, red: 0.3, blue: 0.3 } } } }] }],
                        fields: "userEnteredFormat.backgroundColorStyle"
                    }
                });
            }

            if (rangesToClearDataInSheet.length > 0) {
                await sheetsClient.spreadsheets.values.batchClear({
                    spreadsheetId: SPREADSHEET_ID, resource: { ranges: rangesToClearDataInSheet }
                });
            }
            if (batchUpdateRequestsForFormatting.length > 0) {
                 await sheetsClient.spreadsheets.batchUpdate({
                    spreadsheetId: SPREADSHEET_ID, resource: { requests: batchUpdateRequestsForFormatting }
                });
            }
            console.log(`[TESTWEEK_CMD] Marked all days green and cleared weekly data in Column B.`);
            
            const replyMsg = `All days marked green, weekly data slots cleared. Associated Drive files (${driveFileIdsToClear.length} found) will be deleted in 15 seconds.`;
            replyHelper(interaction, { content: replyMsg }, false, true); // isEdit = true

            if (driveFileIdsToClear.length > 0) {
                setTimeout(async () => {
                    console.log(`[TESTWEEK_DRIVE_DELETE] Attempting to delete ${driveFileIdsToClear.length} Drive files.`);
                    for (const fileId of driveFileIdsToClear) {
                        try {
                            await driveClient.files.delete({ fileId: fileId });
                            console.log(`[TESTWEEK_DRIVE_DELETE] Deleted Drive file ${fileId}.`);
                        } catch (driveError) { console.error(`[TESTWEEK_DRIVE_DELETE_ERROR] Failed to delete Drive file ${fileId}: ${driveError.message}`); }
                    }
                }, 15000);
            } else {
                console.log(`[TESTWEEK_DRIVE_DELETE] No Drive File IDs found to delete.`);
            }

        } catch (error) {
            console.error('[TESTWEEK_CMD_ERROR] Error executing /testweek:', error);
            replyHelper(interaction, { content: 'An error occurred. Check console.' }, false, true); // isEdit = true
        }
    },
};

