// commands/close.js
const { SlashCommandBuilder, PermissionsBitField, MessageFlags, ChannelType } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('close')
        .setDescription('Closes the current ticket channel (deletes it).')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .setDMPermission(false),

    async execute(interaction, client, guildConfigs, saveGuildConfigs, _clearSheetFunction, replyHelper) {
        console.log(`[CLOSE_CMD] Initiated by ${interaction.user.tag} in #${interaction.channel.name}`);

        if (!interaction.inGuild() || !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            replyHelper(interaction, { content: 'This command is for administrators only and must be used in a server.' });
            return;
        }
        
        const channel = interaction.channel;
        const guildConfig = guildConfigs[interaction.guildId];

        if (!guildConfig || channel.type !== ChannelType.GuildText || !channel.name.startsWith('ticket-') || channel.parentId !== guildConfig.ticketCategoryId) {
            replyHelper(interaction, { content: 'This command can only be used inside an active ticket channel created by the bot.' });
            return;
        }

        try {
            // Defer reply is important for operations that might take a moment or involve multiple steps
            console.log(`[CLOSE_CMD] Attempting to defer reply.`);
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); // Use flags
            console.log(`[CLOSE_CMD] Reply deferred successfully.`);

            const closingMessage = `Closing this ticket channel (\`${channel.name}\`) now...`;
            // Edit the deferred reply to confirm action to the admin
            await interaction.editReply({ content: closingMessage }); // No auto-delete for this one, as channel will be gone
            console.log(`[CLOSE_CMD] Admin notified. Deleting channel ${channel.name} in a moment.`);

            // Delete channel after a brief moment
            setTimeout(async () => {
                try {
                    await channel.delete(`Ticket closed by admin: ${interaction.user.tag}`);
                    console.log(`[CLOSE_CMD] Successfully deleted channel ${channel.name}.`);
                } catch (deleteError) {
                    console.error(`[CLOSE_CMD_ERROR] Failed to delete channel ${channel.name}:`, deleteError);
                    // Cannot reliably reply further as the interaction token for editReply might be used,
                    // and the channel context is gone. Logging is primary.
                }
            }, 2000); // 2 seconds

        } catch (error) {
            console.error('[CLOSE_CMD_ERROR] Error executing /close command:', error);
            const errorReplyOptions = { content: 'An error occurred while trying to close this ticket.' };
            if (interaction.deferred || interaction.replied) {
                replyHelper(interaction, errorReplyOptions, false, true); // isEdit = true
            } else {
                replyHelper(interaction, errorReplyOptions);
            }
        }
    },
};

