// commands/setup.js
const { SlashCommandBuilder, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
// const config = require('../config.json'); // This was correctly removed

const EPHEMERAL_DELETE_DELAY = 10000;

async function commandReplyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) { /* ... same helper as v8 ... */ }

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Sets up or updates the ticket system prompt in the current channel.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .setDMPermission(false),

    async execute(interaction, client, guildConfigs, saveGuildConfigs) {
        console.log(`[SETUP_CMD_DEBUG] /setup command execution started by ${interaction.user.tag} in channel ${interaction.channel.name}`); // ADDED DEBUG

        if (!interaction.inGuild()) {
            commandReplyEphemeralAutoDelete(interaction, { content: 'This command can only be used in a server.' });
            return;
        }
        // ... rest of the setup command logic from v8 ...
        // Ensure all interaction.reply, editReply, followUp use commandReplyEphemeralAutoDelete
        // or have their own deferReply() very early if they do significant work.
        // The existing setup.js (v8) already uses deferReply at the start of its try block.
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
        const SHUTDOWN_ROLE_NAME = "Bot Shutdown";
        const shutdownRole = interaction.guild.roles.cache.find(role => role.name === SHUTDOWN_ROLE_NAME);
        const adminRoles = interaction.guild.roles.cache.filter(role =>
            role.permissions.has(PermissionsBitField.Flags.Administrator) &&
            !role.managed &&
            role.id !== interaction.guild.id
        );
        const adminRoleIds = adminRoles.map(role => role.id);

        try {
            console.log(`[SETUP_CMD_DEBUG] Attempting to defer reply for /setup.`);
            await interaction.deferReply({ ephemeral: true }); // This is the crucial first acknowledgement
            console.log(`[SETUP_CMD_DEBUG] Reply deferred successfully.`);

            const openTicketButton = new ButtonBuilder()
                .setCustomId('create_ticket_button')
                .setLabel('🎟️ Open Ticket')
                .setStyle(ButtonStyle.Primary);
            const viewSheetButton = new ButtonBuilder()
                .setCustomId('admin_view_sheet_button')
                .setLabel('📊 View Activity Log (Admins)')
                .setStyle(ButtonStyle.Secondary);
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
            if (existingGuildConfig && existingGuildConfig.promptMessageId && existingGuildConfig.promptChannelId) {
                try {
                    const oldChannel = await client.channels.fetch(existingGuildConfig.promptChannelId).catch(() => null);
                    if (oldChannel) {
                        const oldMessage = await oldChannel.messages.fetch(existingGuildConfig.promptMessageId).catch(() => null);
                        if (oldMessage) {
                            await oldMessage.delete();
                            console.log(`[SETUP] Deleted old prompt message ${existingGuildConfig.promptMessageId} in guild ${interaction.guildId}`);
                        }
                    }
                } catch (err) {
                    console.warn(`[SETUP_WARN] Could not delete old prompt message for guild ${interaction.guildId}: ${err.message}`);
                }
            }

            const promptMessage = await channel.send({ content: initialMessageContent, components: [row] });
            const currentSpreadsheetId = process.env.SPREADSHEET_ID;
            guildConfigs[interaction.guildId] = {
                guildId: interaction.guildId,
                guildName: interaction.guild.name,
                promptChannelId: channel.id,
                promptMessageId: promptMessage.id,
                ticketCategoryId: category.id,
                ticketCategoryName: category.name,
                adminRoleIds: adminRoleIds,
                shutdownRoleId: shutdownRole ? shutdownRole.id : null,
                shutdownRoleName: shutdownRole ? shutdownRole.name : null,
                spreadsheetId: currentSpreadsheetId
            };
            saveGuildConfigs();
            console.log(`--- Setup Command Executed & Config Saved for Guild: ${interaction.guild.name} (${interaction.guildId}) ---`);

            if (client.updatePromptMessage) {
                client.updatePromptMessage(interaction.guildId, promptMessage.id, channel.id, client);
            }

            let setupResponseMessage = `Setup complete! The new ticket prompt has been posted in this channel (${channel.name}).`;
            commandReplyEphemeralAutoDelete(interaction, { content: setupResponseMessage }, false, true); // isEdit = true

        } catch (error) {
            console.error('[ERROR] Error executing /setup command:', error);
            const errorReplyOptions = { content: 'An error occurred during setup. Please check the console and my permissions.' };
            if (interaction.deferred || interaction.replied) { // Should always be deferred at this point
                commandReplyEphemeralAutoDelete(interaction, errorReplyOptions, false, true); // isEdit = true
            } else { // Fallback, though deferReply should have been called
                commandReplyEphemeralAutoDelete(interaction, errorReplyOptions);
            }
        }
    },
};

