// commands/tableclear.js
const { SlashCommandBuilder, PermissionsBitField, MessageFlags } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tableclear')
        .setDescription('Manually clears all weekly data from the Google Sheet and associated Drive files.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .setDMPermission(false),

    async execute(interaction, client, guildConfigs, saveGuildConfigs, _clearSheetFunctionFromIndex, replyHelper, sheetsClient, driveClient, SPREADSHEET_ID, SHEET_NAME, numericSheetId) {
        console.log(`[TABLECLEAR_CMD] Initiated by ${interaction.user.tag}`);

        if (!interaction.inGuild() || !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            replyHelper(interaction, { content: 'This command is for administrators only and must be used in a server.' });
            return;
        }
        if (!sheetsClient || !driveClient || !SPREADSHEET_ID || !SHEET_NAME || typeof numericSheetId === 'undefined') {
            replyHelper(interaction, { content: 'Google Sheets/Drive integration is not ready.' });
            return;
        }

        try {
            console.log(`[TABLECLEAR_CMD] Attempting to defer reply.`);
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); // Use flags
            console.log(`[TABLECLEAR_CMD] Reply deferred successfully.`);

            // Constants (should match index.js)
            const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
            const DAY_SUB_HEADERS = ['Player Display Name', 'Screenshot', 'Timestamp (UTC)', 'Verified', 'Strikes', 'Time in Server', 'Drive File ID'];
            const ROWS_PER_DAY_BLOCK = 1 + DAY_SUB_HEADERS.length;
            const DRIVE_FILE_ID_SUB_HEADER_INDEX = DAY_SUB_HEADERS.indexOf('Drive File ID');

            const driveFileIdsToClear = [];
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
                        range: `'${SHEET_NAME}'!B${driveFileIdCellRow}`,
                    });
                    if (getResponse.data.values?.[0]?.[0]) {
                        driveFileIdsToClear.push(getResponse.data.values[0][0]);
                    }
                } catch (err) { console.warn(`[TABLECLEAR_WARN] No Drive File ID for ${dayName}: ${err.message}`); }
                rangesToClearDataInSheet.push(`'${SHEET_NAME}'!B${startDataRowForDay}:B${endDataRowForDay}`);
            }

            if (rangesToClearDataInSheet.length > 0) {
                await sheetsClient.spreadsheets.values.batchClear({
                    spreadsheetId: SPREADSHEET_ID, resource: { ranges: rangesToClearDataInSheet }
                });
            }
            console.log(`[TABLECLEAR_CMD] Cleared Column B data in sheet '${SHEET_NAME}'.`);

            let deletedDriveCount = 0;
            if (driveFileIdsToClear.length > 0) {
                console.log(`[TABLECLEAR_CMD] Attempting to delete ${driveFileIdsToClear.length} Drive files.`);
                for (const fileId of driveFileIdsToClear) {
                    try {
                        await driveClient.files.delete({ fileId: fileId });
                        console.log(`[TABLECLEAR_CMD] Deleted Drive file ${fileId}.`);
                        deletedDriveCount++;
                    } catch (driveError) { console.error(`[TABLECLEAR_CMD_ERROR] Failed to delete Drive file ${fileId}: ${driveError.message}`); }
                }
            }
            
            const replyMsg = `Sheet data cleared. ${deletedDriveCount}/${driveFileIdsToClear.length} associated Drive files deleted.`;
            replyHelper(interaction, { content: replyMsg }, false, true); // isEdit = true
            console.log(`[TABLECLEAR_CMD] Command completed for ${interaction.user.tag}.`);

        } catch (error) {
            console.error('[TABLECLEAR_CMD_ERROR] Error executing /tableclear:', error);
            replyHelper(interaction, { content: 'An error occurred. Check console.' }, false, true); // isEdit = true
        }
    },
};

