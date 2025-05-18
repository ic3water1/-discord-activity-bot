// commands/close.js
const { SlashCommandBuilder, PermissionsBitField, MessageFlags, ChannelType } = require('discord.js');

const EPHEMERAL_DELETE_DELAY = 10000; // 10 seconds

// Helper function (can be moved to a shared utils file later if used in many commands)
async function commandReplyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) {
    try {
        let sentMessage;
        const currentOptions = { ...options, flags: [MessageFlags.Ephemeral] };

        if (isEdit) {
            sentMessage = await interaction.editReply(currentOptions);
        } else if (isFollowUp) {
            sentMessage = await interaction.followUp(currentOptions);
        } else {
            sentMessage = await interaction.reply(currentOptions);
        }

        if (sentMessage && typeof sentMessage.delete === 'function') {
            setTimeout(() => {
                sentMessage.delete().catch(err => {
                    if (err.code !== 10008) { // Ignore "Unknown Message"
                        console.error(`[AUTO_DELETE_ERROR] Failed to delete ephemeral cmd reply ${sentMessage.id || 'unknown'}:`, err.message);
                    }
                });
            }, EPHEMERAL_DELETE_DELAY);
        }
    } catch (error) {
        console.error(`[CMD_REPLY_ERROR] Failed to send or handle ephemeral auto-delete reply:`, error.message);
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('close')
        .setDescription('Closes the current ticket channel (deletes it).')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator) // Only admins can use
        .setDMPermission(false), // Command cannot be used in DMs

    async execute(interaction, client, guildConfigs, saveGuildConfigs, clearSheetFunction, replyHelper) {
        const currentReplyHelper = typeof replyHelper === 'function' ? replyHelper : commandReplyEphemeralAutoDelete;

        console.log(`[CLOSE_CMD_DEBUG] /close command initiated by ${interaction.user.tag} in channel ${interaction.channel.name} (${interaction.channel.id})`);

        if (!interaction.inGuild()) {
            console.log(`[CLOSE_CMD_DEBUG] Command used outside of a guild.`);
            currentReplyHelper(interaction, { content: 'This command can only be used in a server.' });
            return;
        }

        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            console.log(`[CLOSE_CMD_DEBUG] User ${interaction.user.tag} lacks Administrator permissions.`);
            currentReplyHelper(interaction, { content: 'You must be an administrator to run this command.' });
            return;
        }

        const channel = interaction.channel;
        const guildConfig = guildConfigs[interaction.guildId];

        // Debugging the ticket channel check
        if (!guildConfig) {
            console.log(`[CLOSE_CMD_DEBUG] No guildConfig found for guild ${interaction.guildId}.`);
            currentReplyHelper(interaction, { content: 'Ticket system not configured for this server. Please run /setup.' });
            return;
        }
        console.log(`[CLOSE_CMD_DEBUG] Guild Config Found: Ticket Category ID is ${guildConfig.ticketCategoryId}`);
        console.log(`[CLOSE_CMD_DEBUG] Current Channel: Name='${channel.name}', Type=${channel.type}, ParentID='${channel.parentId}'`);

        const isTextChannel = channel.type === ChannelType.GuildText;
        const nameStartsWithTicket = channel.name.startsWith('ticket-');
        const isInCorrectCategory = channel.parentId === guildConfig.ticketCategoryId;

        console.log(`[CLOSE_CMD_DEBUG] IsTextChannel: ${isTextChannel}, NameStartsWithTicket: ${nameStartsWithTicket}, IsInCorrectCategory: ${isInCorrectCategory}`);


        if (!isTextChannel || !nameStartsWithTicket || !isInCorrectCategory) {
            currentReplyHelper(interaction, { content: 'This command can only be used inside an active ticket channel created by the bot.' });
            return;
        }

        try {
            // Defer reply before sending the visible message to avoid "interaction failed" if deletion is quick
            await interaction.deferReply({ ephemeral: true });

            // Send a temporary visible message in the ticket channel itself (optional)
            // await channel.send({ content: `This ticket will be closed by ${interaction.user.tag} in a few seconds...` });
            
            console.log(`[TICKET_CLOSE_CMD] Admin ${interaction.user.tag} initiated close for ticket channel: ${channel.name} (${channel.id}) in guild ${interaction.guild.name}`);
            
            // Edit the deferred reply to confirm action to the admin
            currentReplyHelper(interaction, { content: `Closing this ticket channel (\`${channel.name}\`) now...` }, false, true); // isEdit = true


            // Add a short delay so the admin sees the confirmation, then delete
            // The actual deletion is quick, the timeout is more for the admin to read the ephemeral reply
            setTimeout(async () => {
                try {
                    await channel.delete(`Ticket closed by admin: ${interaction.user.tag}`);
                    console.log(`[TICKET_CLOSE_CMD] Successfully deleted channel ${channel.name} by admin command.`);
                    // No need to reply again as the channel will be gone.
                } catch (deleteError) {
                    console.error(`[TICKET_CLOSE_CMD_ERROR] Failed to delete channel ${channel.name} by admin command:`, deleteError);
                    // The original interaction might be gone, so a new message to the admin might be hard.
                    // Logging is the most reliable here.
                }
            }, 2000); // 2-second delay before deletion, adjust as needed

        } catch (error) {
            console.error('[CLOSE_CMD_ERROR] Error executing /close command:', error);
            const errorReplyOptions = { content: 'An error occurred while trying to close this ticket.' };
            if (interaction.replied || interaction.deferred) { // Should always be deferred now
                 currentReplyHelper(interaction, errorReplyOptions, false, true); // isEdit = true
            } else {
                 currentReplyHelper(interaction, errorReplyOptions);
            }
        }
    },
};
