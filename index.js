// index.js

console.log("--- index.js script started ---");

// Node.js built-in modules for file and path operations
const fs = require('node:fs');
const path = require('node:path');

// Discord.js and other libraries
const { Client, GatewayIntentBits, Events, Partials, Collection, PermissionsBitField, ChannelType, MessageFlags } = require('discord.js');
const { google } = require('googleapis');
const cron = require('node-cron');
const axios = require('axios');
const stream = require('stream');

// --- Configuration from Environment Variables ---
const TOKEN = process.env.BOT_TOKEN;
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

async function replyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) { /* ... same as v17/final_keep_alive ... */ }
async function ensureSheetHeaders() { /* ... same as v17/final_keep_alive ... */ }
async function authorizeGoogleAPIs() { /* ... same as v17/final_keep_alive ... */ }
const GUILD_CONFIGS_PATH = path.join(__dirname, 'guild-configs.json');
let guildConfigs = {};
let openTickets = {};
function loadGuildConfigs() { /* ... same as v17/final_keep_alive ... */ }
function saveGuildConfigs() { /* ... same as v17/final_keep_alive ... */ }
function formatTimestamp(date, includeSeconds = false, dateOnly = false) { /* ... same (MM-DD-YY format) ... */ }
async function clearSheet() { /* ... same as v17/final_keep_alive ... */ } // This is the sheet-only clear
async function autoResizeSheetColumns() { /* ... same as v17/final_keep_alive ... */ }
function formatDuration(ms, short = false) { /* ... same as v17/final_keep_alive ... */ }
async function updatePromptMessage(guildId, messageId, channelId, clientInstance) { /* ... same as v17/final_keep_alive ... */ }
async function updateAllPromptMessages(clientInstance) { /* ... same as v17/final_keep_alive ... */ }

(async () => {
    console.log("--- Initializing Bot ---");
    if (!TOKEN || !SPREADSHEET_ID || !DRIVE_FOLDER_ID || !GOOGLE_CREDENTIALS_JSON_CONTENT || !SHEET_NAME) {
        console.error("[FATAL_CONFIG_ERROR] Critical environment variables are not set. Exiting.");
        console.log(`  BOT_TOKEN present: ${!!TOKEN}`);
        console.log(`  SPREADSHEET_ID present: ${!!SPREADSHEET_ID}`);
        console.log(`  SHEET_NAME resolved to: ${SHEET_NAME}`);
        console.log(`  GOOGLE_DRIVE_FOLDER_ID present: ${!!DRIVE_FOLDER_ID}`);
        console.log(`  GOOGLE_CREDENTIALS_JSON_CONTENT present: ${!!GOOGLE_CREDENTIALS_JSON_CONTENT}`);
        process.exit(1);
    }
    if (!await authorizeGoogleAPIs()) {
        console.error("[FATAL] Failed to authorize Google APIs.");
    }
    loadGuildConfigs();
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageReactions,
        ],
        partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });
    client.updatePromptMessage = updatePromptMessage;
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, 'commands');
    try {
        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            const command = require(filePath);
            if ('data' in command && 'execute' in command) {
                client.commands.set(command.data.name, command);
                console.log(`[CMDS] Loaded command: /${command.data.name}`);
            } else {
                console.log(`[WARNING] Command at ${filePath} missing "data" or "execute".`);
            }
        }
    } catch (error) {
        console.error(`[ERROR] Could not read commands dir:`, error);
    }

    client.once(Events.ClientReady, readyClient => {
        console.log(`\nReady! Logged in as ${readyClient.user.tag}`);
        console.log(`Bot ID: ${readyClient.user.id}`);
        console.log(`Bot is in ${readyClient.guilds.cache.size} guilds.`);
        cron.schedule('0 0 * * 0', () => { console.log('[CRON] Running weekly sheet clear job...'); clearSheet(); }, { scheduled: true, timezone: "UTC" });
        console.log('[CRON] Weekly sheet clear scheduled for Sunday 00:00 UTC.');
        setInterval(() => updateAllPromptMessages(client), 60000);
        updateAllPromptMessages(client);
        console.log('[PROMPT_UPDATE] Periodic prompt message updates scheduled (every 1 min).');
    });

    // --- MODIFIED Event Handler: InteractionCreate ---
    client.on(Events.InteractionCreate, async interaction => {
        console.log(`[INTERACTION_DEBUG] Received interaction: Type=${interaction.type}, ID=${interaction.id}, User=${interaction.user.tag}`);

        if (!interaction.inGuild()) {
            console.log(`[INTERACTION_DEBUG] Interaction not in guild. Ignoring.`);
            return;
        }
        const guildConfig = guildConfigs[interaction.guildId];

        if (interaction.isChatInputCommand()) {
            console.log(`[INTERACTION_DEBUG] Handling ChatInputCommand: /${interaction.commandName}`);
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) {
                console.error(`[INTERACTION_ERROR] No command matching /${interaction.commandName} was found.`);
                replyEphemeralAutoDelete(interaction, { content: `Error: Command /${interaction.commandName} not found.` });
                return;
            }
            try {
                console.log(`[INTERACTION_DEBUG] Executing command: /${interaction.commandName}`);
                await command.execute(interaction, client, guildConfigs, saveGuildConfigs, clearSheet, replyEphemeralAutoDelete, sheetsClient, driveClient, SPREADSHEET_ID, SHEET_NAME, numericSheetId);
            } catch (error) {
                console.error(`[INTERACTION_ERROR] Error executing /${interaction.commandName}:`, error);
                const errorReplyOptions = { content: 'There was an error while executing this command!' };
                if (interaction.replied || interaction.deferred) {
                    replyEphemeralAutoDelete(interaction, errorReplyOptions, true); // isFollowUp = true
                } else {
                    replyEphemeralAutoDelete(interaction, errorReplyOptions);
                }
            }
        } else if (interaction.isButton()) {
            console.log(`[INTERACTION_DEBUG] Handling ButtonInteraction: CustomID=${interaction.customId}`);
            // ... (Button interaction logic from v17 - ensure ephemeral replies use the helper)
            // Make sure to add console.log before any await interaction.reply or deferReply
            if (interaction.customId === 'create_ticket_button') {
                console.log(`[INTERACTION_DEBUG] 'create_ticket_button' pressed.`);
                // ... rest of create_ticket_button logic ...
                 if (!guildConfig) { replyEphemeralAutoDelete(interaction, { content: 'Ticket system not configured.' }); return; }
                const member = interaction.member;
                if (guildConfig.shutdownRoleId && member.roles.cache.has(guildConfig.shutdownRoleId)) { replyEphemeralAutoDelete(interaction, { content: `You have the "${guildConfig.shutdownRoleName || 'shutdown'}" role and cannot create tickets.` }); return; }
                if (openTickets[interaction.guildId]?.[member.id]) {
                    const existingTicketChannel = interaction.guild.channels.cache.get(openTickets[interaction.guildId][member.id]);
                    if (existingTicketChannel) { replyEphemeralAutoDelete(interaction, { content: `You already have an open ticket: ${existingTicketChannel}.` }); return; }
                    delete openTickets[interaction.guildId][member.id];
                }
                const ticketCategory = interaction.guild.channels.cache.get(guildConfig.ticketCategoryId);
                if (!ticketCategory || ticketCategory.type !== ChannelType.GuildCategory) { replyEphemeralAutoDelete(interaction, { content: 'Error: Ticket category not found.' }); return; }
                const userNameForChannel = member.user.username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'user';
                const ticketChannelName = `ticket-${userNameForChannel}-${member.user.discriminator === '0' ? member.user.id.slice(-4) : member.user.discriminator}`;
                try {
                    console.log(`[INTERACTION_DEBUG] Deferring reply for create_ticket_button.`);
                    await interaction.deferReply({ ephemeral: true });
                    // ... rest of ticket creation logic ...
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
                    const ticketChannel = await ticketCategory.children.create({ name: ticketChannelName, type: ChannelType.GuildText, topic: `Ticket for ${member.user.tag} (ID: ${member.user.id}). Created: ${new Date().toUTCString()}`, permissionOverwrites });
                    const adminMentions = guildConfig.adminRoleIds?.map(id => `<@&${id}>`).join(' ') || 'Administrators';
                    await ticketChannel.send({ content: `👋 Hello ${member.toString()}, welcome to your ticket!\n\n🛡️ ${adminMentions} have access to this channel.\n\n🖼️ Please send in your **daily activity screenshot** here or describe any issues you have.` });
                    if (!openTickets[interaction.guildId]) openTickets[interaction.guildId] = {};
                    openTickets[interaction.guildId][member.id] = ticketChannel.id;
                    replyEphemeralAutoDelete(interaction, { content: `Your ticket has been created: ${ticketChannel}` }, false, true);
                    console.log(`Ticket ${ticketChannel.name} created for ${member.user.tag}.`);
                    const timeoutId = setTimeout(async () => {
                        try {
                            const fetchedChannel = await client.channels.fetch(ticketChannel.id).catch(() => null);
                            if (fetchedChannel && fetchedChannel.lastMessageId === null) {
                                console.log(`[TICKET_CLEANUP] Ticket ${fetchedChannel.name} is blank after timeout, deleting.`);
                                await fetchedChannel.delete('Blank ticket auto-deleted');
                                blankTicketTimeouts.delete(ticketChannel.id);
                            }
                        } catch (err) {
                            console.error(`[TICKET_CLEANUP_ERROR] Could not delete blank ticket ${ticketChannel.name}:`, err.message);
                        }
                    }, 60000);
                    blankTicketTimeouts.set(ticketChannel.id, timeoutId);

                } catch (error) {
                    console.error(`[ERROR] Failed to create ticket for ${member.user.tag}:`, error);
                    replyEphemeralAutoDelete(interaction, { content: 'Error creating ticket. Ensure bot has permissions.'}, false, true); // isEdit = true
                }
            } else if (interaction.customId === 'admin_view_sheet_button') {
                console.log(`[INTERACTION_DEBUG] 'admin_view_sheet_button' pressed.`);
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    replyEphemeralAutoDelete(interaction, { content: 'You do not have permission to use this button.' }); return;
                }
                const currentGuildConfig = guildConfigs[interaction.guildId];
                let replyOptions;
                if (currentGuildConfig && currentGuildConfig.spreadsheetId) {
                    const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${currentGuildConfig.spreadsheetId}/edit`;
                    replyOptions = { content: `📊 **Activity Log Sheet:** <${spreadsheetUrl}>` };
                } else if (SPREADSHEET_ID) {
                     const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;
                    replyOptions = { content: `📊 **Activity Log Sheet (Global Fallback):** <${spreadsheetUrl}>` };
                } else {
                    replyOptions = { content: 'Spreadsheet ID not configured.' };
                }
                replyEphemeralAutoDelete(interaction, replyOptions);
            }
        }
    });

    client.on(Events.MessageCreate, async message => { /* ... same message creation logic as v17 (Google Drive version, 9 headers) ... */ });
    client.on(Events.ChannelDelete, channel => { /* ... same channel delete logic as v17 ... */ });

    try {
        await client.login(TOKEN);
        console.log("Login to Discord successful!");
    } catch (error) { /* ... same login error handling ... */ }

    console.log("[INFO] Bot is running and listening for events. Process will be kept alive.");
    await new Promise(() => {});

})();

