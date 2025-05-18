// commands/testday.js
const { SlashCommandBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const { google } = require('googleapis'); // Required for color formatting

// Constants (ensure these match index.js or are passed/imported if centralized)
const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SUB_HEADERS = [
    'Player Display Name', 'Screenshot', 'Timestamp (UTC)',
    'Verified', 'Strikes', 'Time in Server', 'Drive File ID'
];
const ROWS_PER_DAY_BLOCK = 1 + DAY_SUB_HEADERS.length;
const DRIVE_FILE_ID_SUB_HEADER_INDEX = DAY_SUB_HEADERS.indexOf('Drive File ID');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('testday')
        .setDescription('TEST CMD: Marks current day green, clears its data, and deletes its Drive screenshot after 15s.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .setDMPermission(false),

    async execute(interaction, client, guildConfigs, saveGuildConfigs, _clearSheetFunction, replyHelper, sheetsClient, driveClient, SPREADSHEET_ID, SHEET_NAME, numericSheetId) {
        console.log(`[TESTDAY_CMD] Initiated by ${interaction.user.tag}`);

        if (!interaction.inGuild() || !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            replyHelper(interaction, { content: 'This command is for administrators only and must be used in a server.' });
            return;
        }
        if (!sheetsClient || !driveClient || !SPREADSHEET_ID || !SHEET_NAME || typeof numericSheetId === 'undefined') {
            replyHelper(interaction, { content: 'Google Sheets/Drive integration is not ready. Cannot perform /testday.' });
            return;
        }

        try {
            console.log(`[TESTDAY_CMD] Attempting to defer reply.`);
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); // Use flags
            console.log(`[TESTDAY_CMD] Reply deferred successfully.`);

            const currentDate = new Date();
            const currentDayIndex = currentDate.getUTCDay();
            const currentDayName = DAYS_OF_WEEK[currentDayIndex];

            const dayHeaderRowIndex = (currentDayIndex * ROWS_PER_DAY_BLOCK) + 1;
            const startDataRowForDay = dayHeaderRowIndex + 1;
            const endDataRowForDay = startDataRowForDay + DAY_SUB_HEADERS.length - 1;
            const driveFileIdCellRow = startDataRowForDay + DRIVE_FILE_ID_SUB_HEADER_INDEX;

            let driveFileIdToClear = null;
            try {
                const getResponse = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `'${SHEET_NAME}'!B${driveFileIdCellRow}`, // Drive File ID is in Column B
                });
                if (getResponse.data.values?.[0]?.[0]) {
                    driveFileIdToClear = getResponse.data.values[0][0];
                }
            } catch (err) {
                console.warn(`[TESTDAY_WARN] Could not read Drive File ID for ${currentDayName}: ${err.message}`);
            }

            const requests = [
                {
                    updateCells: {
                        range: { sheetId: numericSheetId, startRowIndex: startDataRowForDay - 1, endRowIndex: endDataRowForDay, startColumnIndex: 1, endColumnIndex: 2 },
                        rows: Array(DAY_SUB_HEADERS.length).fill({ values: [{ userEnteredValue: { stringValue: "" } }] }),
                        fields: "userEnteredValue"
                    }
                },
                {
                    updateCells: {
                        range: { sheetId: numericSheetId, startRowIndex: dayHeaderRowIndex - 1, endRowIndex: dayHeaderRowIndex, startColumnIndex: 0, endColumnIndex: 1 },
                        rows: [{ values: [{ userEnteredFormat: { backgroundColorStyle: { rgbColor: { green: 0.7, red: 0.3, blue: 0.3 } } } }] }],
                        fields: "userEnteredFormat.backgroundColorStyle"
                    }
                }
            ];

            await sheetsClient.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests } });
            console.log(`[TESTDAY_CMD] Marked ${currentDayName} green and cleared its data.`);
            
            const replyMsg = `${currentDayName}'s data slot has been cleared and marked green. Associated Drive file (ID: ${driveFileIdToClear || 'None'}) will be deleted in 15 seconds.`;
            replyHelper(interaction, { content: replyMsg }, false, true); // isEdit = true

            if (driveFileIdToClear) {
                setTimeout(async () => {
                    try {
                        console.log(`[TESTDAY_DRIVE_DELETE] Attempting to delete Drive File ID: ${driveFileIdToClear} for ${currentDayName}.`);
                        await driveClient.files.delete({ fileId: driveFileIdToClear });
                        console.log(`[TESTDAY_DRIVE_DELETE] Successfully deleted Drive file ${driveFileIdToClear}.`);
                    } catch (driveError) {
                        console.error(`[TESTDAY_DRIVE_DELETE_ERROR] Failed to delete Drive file ${driveFileIdToClear}: ${driveError.message}`);
                    }
                }, 15000);
            } else {
                console.log(`[TESTDAY_DRIVE_DELETE] No Drive File ID found for ${currentDayName} to delete.`);
            }

        } catch (error) {
            console.error('[TESTDAY_CMD_ERROR] Error executing /testday:', error);
            replyHelper(interaction, { content: 'An error occurred. Check console.' }, false, true); // isEdit = true
        }
    },
};

