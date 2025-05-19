// commands/setup.js
const { SlashCommandBuilder, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
// No longer requiring '../config.json' here as SPREADSHEET_ID will come from process.env for the guildConfig storage

const EPHEMERAL_DELETE_DELAY = 10000; // 10 seconds

// Helper function to send and then delete an ephemeral reply (local to this command file)
async function commandReplyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) {
    try {
        let sentMessage;
        // Ensure flags are always set for ephemeral messages
        const currentOptions = { ...options, flags: [MessageFlags.Ephemeral] };

        if (isEdit) {
            // console.log(`[SETUP_CMD_HELPER_DEBUG] Attempting to editReply for interaction ${interaction.id}`);
            sentMessage = await interaction.editReply(currentOptions);
        } else if (isFollowUp) { // This command likely won't use followUp for its primary ephemeral response
            // console.log(`[SETUP_CMD_HELPER_DEBUG] Attempting to followUp for interaction ${interaction.id}`);
            sentMessage = await interaction.followUp(currentOptions);
        } else {
            // console.log(`[SETUP_CMD_HELPER_DEBUG] Attempting to reply for interaction ${interaction.id}`);
            sentMessage = await interaction.reply(currentOptions);
        }
        // console.log(`[SETUP_CMD_HELPER_DEBUG] Reply/Edit/FollowUp sent for interaction ${interaction.id}`);

        if (sentMessage && typeof sentMessage.delete === 'function') {
            setTimeout(() => {
                sentMessage.delete().catch(err => {
                    if (err.code !== 10008) { // Silently ignore "Unknown Message"
                        console.error(`[SETUP_CMD_AUTO_DELETE_ERROR] Ephemeral reply ${sentMessage.id || 'unknown'} for interaction ${interaction.id}:`, err.message);
                    }
                });
            }, EPHEMERAL_DELETE_DELAY);
        }
    } catch (error) {
        console.error(`[SETUP_CMD_REPLY_ERROR] Failed to send/edit/followUp for interaction ${interaction.id}:`, error.message);
        // Avoid re-throwing or replying again if the helper itself fails
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Sets up or updates the ticket system prompt in the current channel.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .setDMPermission(false),

    async execute(interaction, client, guildConfigs, saveGuildConfigs) { // Note: clearSheet, sheetsClient, etc. removed from signature
        console.log(`[SETUP_CMD] Initiated by ${interaction.user.tag} in #${interaction.channel.name} (Guild: ${interaction.guild.name})`);

        if (!interaction.inGuild()) {
            commandReplyEphemeralAutoDelete(interaction, { content: 'This command can only be used in a server.' });
            return;
        }
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            commandReplyEphemeralAutoDelete(interaction, { content: 'You must be an administrator to run this command.' });
            return;
        }
        const channel = interaction.channel;
        if (channel.type !== ChannelType.GuildText) {
            commandReplyEphemeralAutoDelete(interaction, { content: 'This command must be used in a standard text channel.' });
            return;
        }
        if (!channel.parentId) {
            commandReplyEphemeralAutoDelete(interaction, { content: 'This channel is not in a category. Please run this command in a channel that is within a category designated for ticket prompts.' });
            return;
        }
        const category = channel.parent;
        const SHUTDOWN_ROLE_NAME = "Bot Shutdown"; // You can make this configurable later
        const shutdownRole = interaction.guild.roles.cache.find(role => role.name === SHUTDOWN_ROLE_NAME);
        const adminRoles = interaction.guild.roles.cache.filter(role =>
            role.permissions.has(PermissionsBitField.Flags.Administrator) && !role.managed && role.id !== interaction.guild.id
        );
        const adminRoleIds = adminRoles.map(role => role.id);

        try {
            console.log(`[SETUP_CMD] Attempting to defer reply.`);
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            console.log(`[SETUP_CMD] Reply deferred successfully.`);

            const openTicketButton = new ButtonBuilder().setCustomId('create_ticket_button').setLabel('🎟️ Open Ticket').setStyle(ButtonStyle.Primary);
            const viewSheetButton = new ButtonBuilder().setCustomId('admin_view_sheet_button').setLabel('📊 View Activity Log (Admins)').setStyle(ButtonStyle.Secondary);
            const row = new ActionRowBuilder().addComponents(openTicketButton, viewSheetButton);
            
            const initialMessageContent =
`**Welcome to the Screenshot Submission System!** 🗓️

Click the "🎟️ Open Ticket" button below to create a private channel where you can submit your **daily activity screenshot**.

**Submission Guidelines:**
- You are expected to submit one (1) screenshot per day for 7 consecutive days.
- Submissions are logged, and admins will verify them.
- This system is used to track activity—each day you fail to submit (without informing an admin) may count as a strike.
- Three (3) strikes and you're out of the guild.
- The strike log resets weekly on Sunday at 00:00 UTC.

*Initializing submission deadline countdown...*`;

            const existingGuildConfig = guildConfigs[interaction.guildId];
            if (existingGuildConfig?.promptMessageId && existingGuildConfig?.promptChannelId) {
                try {
                    const oldChannel = await client.channels.fetch(existingGuildConfig.promptChannelId).catch(() => null);
                    if (oldChannel) {
                        const oldMessage = await oldChannel.messages.fetch(existingGuildConfig.promptMessageId).catch(() => null);
                        if (oldMessage) { await oldMessage.delete(); console.log(`[SETUP_CMD] Deleted old prompt message ${existingGuildConfig.promptMessageId}`); }
                    }
                } catch (err) { console.warn(`[SETUP_CMD_WARN] Could not delete old prompt message: ${err.message}`); }
            }

            const promptMessage = await channel.send({ content: initialMessageContent, components: [row] });
            
            const currentSpreadsheetId = process.env.SPREADSHEET_ID; // Get from global env

            guildConfigs[interaction.guildId] = {
                guildId: interaction.guildId, guildName: interaction.guild.name,
                promptChannelId: channel.id, promptMessageId: promptMessage.id,
                ticketCategoryId: category.id, ticketCategoryName: category.name,
                adminRoleIds: adminRoleIds,
                shutdownRoleId: shutdownRole ? shutdownRole.id : null,
                shutdownRoleName: shutdownRole ? shutdownRole.name : null,
                spreadsheetId: currentSpreadsheetId // For the admin_view_sheet_button
            };
            saveGuildConfigs();
            console.log(`[SETUP_CMD] Config saved for G:${interaction.guild.name}. PromptMsgID: ${promptMessage.id}`);

            if (client.updatePromptMessage) {
                client.updatePromptMessage(interaction.guildId, promptMessage.id, channel.id, client);
            }

            let setupResponseMessage = `Setup complete! The new ticket prompt has been posted in #${channel.name}. Category: "${category.name}".`;
            commandReplyEphemeralAutoDelete(interaction, { content: setupResponseMessage }, false, true); // isEdit = true
            console.log(`[SETUP_CMD] Sent final confirmation to admin.`);

        } catch (error) {
            console.error('[SETUP_CMD_ERROR] Error executing /setup:', error);
            const errorReplyOptions = { content: 'An error occurred during setup. Please check the console and bot permissions.' };
            // Ensure we try to edit the deferred reply if an error occurs after deferral
            if (interaction.deferred) { // No need to check interaction.replied if we always defer
                commandReplyEphemeralAutoDelete(interaction, errorReplyOptions, false, true); // isEdit = true
            } else {
                // This case should ideally not be reached if deferReply is always called first in try block
                commandReplyEphemeralAutoDelete(interaction, errorReplyOptions);
            }
        }
    },
};

