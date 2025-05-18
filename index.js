// index.js

console.log("--- index.js script started ---");

const { Client, GatewayIntentBits, Events, Partials, Collection, PermissionsBitField, ChannelType, MessageFlags } = require('discord.js');
const TOKEN = process.env.BOT_TOKEN;
const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');
const cron = require('node-cron');
const axios = require('axios');
const stream = require('stream');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const GOOGLE_CREDENTIALS_JSON_CONTENT = process.env.GOOGLE_CREDENTIALS_JSON;

const API_SCOPES = [ /* ... */ ];
const EXPECTED_HEADERS = [ /* ... 9 headers ... */ ];
const COLUMN_DISCORD_TAG = 'A';
const TIMESTAMP_COLUMN_INDEX = EXPECTED_HEADERS.indexOf('Timestamp (UTC)');
const DRIVE_FILE_ID_COLUMN_INDEX = EXPECTED_HEADERS.indexOf('Drive File ID');

let sheetsClient;
let driveClient;
let googleAuthClient;
let numericSheetId;

const blankTicketTimeouts = new Map();
const EPHEMERAL_DELETE_DELAY = 10000;

async function replyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) {
    try {
        let sentMessage;
        const currentOptions = { ...options, flags: [MessageFlags.Ephemeral] };
        const interactionType = interaction.isButton() ? "Button" : interaction.isChatInputCommand() ? "SlashCommand" : "UnknownInteraction";
        
        if (isEdit) {
            console.log(`[REPLY_HELPER_DEBUG] Attempting to editReply for ${interactionType} ${interaction.id}`);
            sentMessage = await interaction.editReply(currentOptions);
        } else if (isFollowUp) {
            console.log(`[REPLY_HELPER_DEBUG] Attempting to followUp for ${interactionType} ${interaction.id}`);
            sentMessage = await interaction.followUp(currentOptions);
        } else {
            console.log(`[REPLY_HELPER_DEBUG] Attempting to reply for ${interactionType} ${interaction.id}`);
            sentMessage = await interaction.reply(currentOptions);
        }
        console.log(`[REPLY_HELPER_DEBUG] Reply/Edit/FollowUp sent for ${interactionType} ${interaction.id}`);

        if (sentMessage && typeof sentMessage.delete === 'function') {
            setTimeout(() => {
                sentMessage.delete().catch(err => {
                    if (err.code !== 10008) console.error(`[AUTO_DELETE_ERROR] Ephemeral reply ${sentMessage.id || 'unknown'} for ${interactionType} ${interaction.id}:`, err.message);
                });
            }, EPHEMERAL_DELETE_DELAY);
        }
    } catch (error) {
        console.error(`[REPLY_ERROR] Failed to send/edit/followUp for interaction ${interaction.id}:`, error.message);
    }
}

async function ensureSheetHeaders() { /* ... same as discord_js_index_final_keep_alive_retrieved ... */ }
async function authorizeGoogleAPIs() { /* ... same as discord_js_index_final_keep_alive_retrieved ... */ }
const GUILD_CONFIGS_PATH = path.join(__dirname, 'guild-configs.json');
let guildConfigs = {};
let openTickets = {};
function loadGuildConfigs() { /* ... same ... */ }
function saveGuildConfigs() { /* ... same ... */ }
function formatTimestamp(date, includeSeconds = false, dateOnly = false) { /* ... same ... */ }
async function clearSheet() { /* ... same (weekly sheet-only clear) ... */ }
async function autoResizeSheetColumns() { /* ... same ... */ }
function formatDuration(ms, short = false) { /* ... same ... */ }
async function updatePromptMessage(guildId, messageId, channelId, clientInstance) { /* ... same ... */ }
async function updateAllPromptMessages(clientInstance) { /* ... same ... */ }

(async () => {
    console.log("--- Initializing Bot ---");
    if (!TOKEN || !SPREADSHEET_ID || !DRIVE_FOLDER_ID || !GOOGLE_CREDENTIALS_JSON_CONTENT || !SHEET_NAME) {
        console.error("[FATAL_CONFIG_ERROR] Critical environment variables are not set. Exiting.");
        process.exit(1);
    }
    if (!await authorizeGoogleAPIs()) {
        console.error("[FATAL] Failed to authorize Google APIs.");
    }
    loadGuildConfigs();
    const client = new Client({
        intents: [ /* ... same ... */ ],
        partials: [ /* ... same ... */ ],
    });
    client.updatePromptMessage = updatePromptMessage;
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, 'commands');
    try { /* ... command loading ... */ } catch (error) { /* ... */ }
    client.once(Events.ClientReady, readyClient => { /* ... same ... */ });

    client.on(Events.InteractionCreate, async interaction => {
        console.log(`[INTERACTION_DEBUG] Received interaction: Type=${interaction.type}, CustomID/CommandName=${interaction.customId || interaction.commandName}, User=${interaction.user.tag}, Guild=${interaction.guildId}`);
        if (!interaction.inGuild()) { console.log(`[INTERACTION_DEBUG] Interaction not in guild. Ignoring.`); return; }
        
        const guildConfig = guildConfigs[interaction.guildId]; // Defined once here

        if (interaction.isChatInputCommand()) {
            // ... (ChatInputCommand logic from discord_js_index_interaction_debug, using replyEphemeralAutoDelete)
        } else if (interaction.isButton()) {
            console.log(`[INTERACTION_DEBUG] Handling ButtonInteraction: CustomID=${interaction.customId}`);
            if (interaction.customId === 'create_ticket_button') {
                console.log(`[TICKET_BUTTON_DEBUG] 'create_ticket_button' pressed by ${interaction.user.tag}.`);

                if (!guildConfig) {
                    console.log(`[TICKET_BUTTON_DEBUG] No guildConfig for guild ${interaction.guildId}. Replying.`);
                    replyEphemeralAutoDelete(interaction, { content: 'Ticket system not configured for this server yet. Please ask an administrator to run /setup.' });
                    return;
                }
                console.log(`[TICKET_BUTTON_DEBUG] GuildConfig found.`);

                const member = interaction.member;
                if (guildConfig.shutdownRoleId && member.roles.cache.has(guildConfig.shutdownRoleId)) {
                    console.log(`[TICKET_BUTTON_DEBUG] User ${member.user.tag} has shutdown role. Replying.`);
                    replyEphemeralAutoDelete(interaction, { content: `You currently have the "${guildConfig.shutdownRoleName || 'shutdown'}" role and cannot create new tickets.` });
                    return;
                }
                console.log(`[TICKET_BUTTON_DEBUG] Shutdown role check passed.`);

                if (openTickets[interaction.guildId]?.[member.id]) {
                    const existingTicketChannelId = openTickets[interaction.guildId][member.id];
                    const existingTicketChannel = interaction.guild.channels.cache.get(existingTicketChannelId);
                    if (existingTicketChannel) {
                        console.log(`[TICKET_BUTTON_DEBUG] User ${member.user.tag} already has open ticket ${existingTicketChannel.name}. Replying.`);
                        replyEphemeralAutoDelete(interaction, { content: `You already have an open ticket: ${existingTicketChannel}. Please use your existing ticket or ask for it to be closed.` });
                        return;
                    }
                    console.log(`[TICKET_BUTTON_DEBUG] Stale open ticket record found for user ${member.user.tag}, clearing.`);
                    delete openTickets[interaction.guildId][member.id];
                }
                console.log(`[TICKET_BUTTON_DEBUG] No existing open ticket found for user.`);

                const ticketCategory = interaction.guild.channels.cache.get(guildConfig.ticketCategoryId);
                if (!ticketCategory || ticketCategory.type !== ChannelType.GuildCategory) {
                    console.log(`[TICKET_BUTTON_DEBUG] Ticket category (ID: ${guildConfig.ticketCategoryId}) not found or not a category. Replying.`);
                    replyEphemeralAutoDelete(interaction, { content: 'Error: The configured ticket category could not be found. Please ask an admin to re-run /setup.' });
                    return;
                }
                console.log(`[TICKET_BUTTON_DEBUG] Ticket category "${ticketCategory.name}" found.`);
                
                try {
                    console.log(`[TICKET_BUTTON_DEBUG] Attempting to deferReply.`);
                    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                    console.log(`[TICKET_BUTTON_DEBUG] Reply deferred successfully.`);

                    const userNameForChannel = member.user.username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'user';
                    const ticketChannelName = `ticket-${userNameForChannel}-${member.user.discriminator === '0' ? member.user.id.slice(-4) : member.user.discriminator}`;
                    console.log(`[TICKET_BUTTON_DEBUG] Generated ticket channel name: ${ticketChannelName}`);

                    const permissionOverwrites = [
                        { id: interaction.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
                        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels] },
                    ];
                    if (guildConfig.adminRoleIds?.length > 0) {
                        guildConfig.adminRoleIds.forEach(roleId => {
                            if (interaction.guild.roles.cache.has(roleId)) permissionOverwrites.push({ id: roleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.ManageMessages] });
                        });
                    }
                    console.log(`[TICKET_BUTTON_DEBUG] Creating channel in category ${ticketCategory.name}...`);
                    const ticketChannel = await ticketCategory.children.create({ name: ticketChannelName, type: ChannelType.GuildText, topic: `Ticket for ${member.user.tag} (ID: ${member.user.id}). Created: ${new Date().toUTCString()}`, permissionOverwrites });
                    console.log(`[TICKET_BUTTON_DEBUG] Channel ${ticketChannel.name} created.`);

                    const adminMentions = guildConfig.adminRoleIds?.map(id => `<@&${id}>`).join(' ') || 'Administrators';
                    await ticketChannel.send({ content: `👋 Hello ${member.toString()}, welcome to your ticket!\n\n🛡️ ${adminMentions} have access to this channel.\n\n🖼️ Please send in your **daily activity screenshot** here or describe any issues you have.` });
                    
                    if (!openTickets[interaction.guildId]) openTickets[interaction.guildId] = {};
                    openTickets[interaction.guildId][member.id] = ticketChannel.id;
                    
                    replyEphemeralAutoDelete(interaction, { content: `Your ticket has been created: ${ticketChannel}` }, false, true); // isEdit = true
                    console.log(`[TICKET_BUTTON_DEBUG] Ticket ${ticketChannel.name} creation confirmed for ${member.user.tag}.`);
                    
                    const timeoutId = setTimeout(async () => { /* ... blank ticket cleanup ... */ }, 60000);
                    blankTicketTimeouts.set(ticketChannel.id, timeoutId);

                } catch (error) {
                    console.error(`[TICKET_BUTTON_ERROR] Failed to create ticket for ${member.user.tag}:`, error);
                    replyEphemeralAutoDelete(interaction, { content: 'Error creating ticket. Ensure bot has permissions and setup is correct.'}, false, true); // isEdit = true
                }
            } else if (interaction.customId === 'admin_view_sheet_button') { /* ... same as v17/interaction_debug ... */ }
        }
    });

    client.on(Events.MessageCreate, async message => { /* ... same as v19 (daily slot sheet format) ... */ });
    client.on(Events.ChannelDelete, channel => { /* ... same ... */ });

    try {
        await client.login(TOKEN);
        console.log("Login to Discord successful!");
    } catch (error) { /* ... same login error handling ... */ }

    console.log("[INFO] Bot is running and listening for events. Process will be kept alive.");
    await new Promise(() => {});
})();

