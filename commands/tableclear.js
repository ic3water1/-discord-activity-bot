// commands/tableclear.js
const { SlashCommandBuilder, PermissionsBitField, MessageFlags } = require('discord.js');

const EPHEMERAL_DELETE_DELAY = 10000; // 10 seconds

// Helper function (can be moved to a shared utils file later if used in many commands)
async function commandReplyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) {
    try {
        let sentMessage;
        if (isEdit) {
            sentMessage = await interaction.editReply(options);
        } else if (isFollowUp) {
            sentMessage = await interaction.followUp(options);
        } else {
            sentMessage = await interaction.reply(options);
        }

        if (sentMessage && sentMessage.delete && typeof sentMessage.delete === 'function') {
            setTimeout(() => {
                sentMessage.delete().catch(err => console.error(`[AUTO_DELETE_ERROR] Failed to delete ephemeral cmd reply ${sentMessage.id}:`, err.message));
            }, EPHEMERAL_DELETE_DELAY);
        }
    } catch (error) {
        console.error(`[CMD_REPLY_ERROR] Failed to send or handle ephemeral auto-delete reply:`, error.message);
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tableclear')
        .setDescription('Manually clears the data from the Google Sheet (preserves headers).')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .setDMPermission(false),

    async execute(interaction, client, guildConfigs, saveGuildConfigs, clearSheetFunction) {
        if (!interaction.inGuild()) {
            commandReplyEphemeralAutoDelete(interaction, { content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
            return;
        }

        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            commandReplyEphemeralAutoDelete(interaction, { content: 'You must be an administrator to run this command.', flags: [MessageFlags.Ephemeral] });
            return;
        }

        if (typeof clearSheetFunction !== 'function') {
            console.error('[TABLECLEAR_ERROR] clearSheetFunction is not available.');
            commandReplyEphemeralAutoDelete(interaction, { content: 'Error: The table clearing function is not available.', flags: [MessageFlags.Ephemeral] });
            return;
        }

        try {
            await interaction.deferReply({ ephemeral: true }); // Defer the reply
            const cleared = await clearSheetFunction(); // Call the clearSheet function

            if (cleared) {
                const successReplyOptions = { content: 'The Google Sheet data has been successfully cleared (headers preserved).' };
                commandReplyEphemeralAutoDelete(interaction, successReplyOptions, false, true); // isEdit = true
                console.log(`[TABLECLEAR] Sheet manually cleared by ${interaction.user.tag} in guild ${interaction.guild.name}`);
            } else {
                 const failureReplyOptions = { content: 'Failed to clear the Google Sheet. Please check bot console.' };
                commandReplyEphemeralAutoDelete(interaction, failureReplyOptions, false, true); // isEdit = true
            }

        } catch (error) {
            console.error('[TABLECLEAR_ERROR] Failed to manually clear sheet:', error);
            const errorReplyOptions = { content: 'An error occurred while trying to clear the sheet. Please check the bot console.' };
            commandReplyEphemeralAutoDelete(interaction, errorReplyOptions, false, true); // isEdit = true
        }
    },
};

