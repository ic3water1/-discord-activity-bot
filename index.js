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

const API_SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
];
const EXPECTED_HEADERS = [
    'Discord Tag', 'Player Display Name', 'Screenshot', 'Timestamp (UTC)',
    'Verified', 'Strikes', 'Time in Server', 'Ticket Channel Name', 'Drive File ID'
];
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
        const currentOptions = { ...options, flags: [MessageFlags.Ephemeral] }; // Ensure flags are always set

        if (isEdit) {
            console.log(`[INTERACTION_REPLY_DEBUG] Attempting to editReply for interaction ${interaction.id}`);
            sentMessage = await interaction.editReply(currentOptions);
        } else if (isFollowUp) {
            console.log(`[INTERACTION_REPLY_DEBUG] Attempting to followUp for interaction ${interaction.id}`);
            sentMessage = await interaction.followUp(currentOptions);
        } else {
            console.log(`[INTERACTION_REPLY_DEBUG] Attempting to reply for interaction ${interaction.id}`);
            sentMessage = await interaction.reply(currentOptions);
        }
        console.log(`[INTERACTION_REPLY_DEBUG] Reply/Edit/FollowUp sent for interaction ${interaction.id}`);

        if (sentMessage && typeof sentMessage.delete === 'function') {
            setTimeout(() => {
                sentMessage.delete().catch(err => {
                    if (err.code !== 10008) { // Ignore "Unknown Message"
                        console.error(`[AUTO_DELETE_ERROR] Ephemeral reply ${sentMessage.id || 'unknown'} for interaction ${interaction.id}:`, err.message);
                    }
                });
            }, EPHEMERAL_DELETE_DELAY);
        }
    } catch (error) {
        console.error(`[REPLY_ERROR] Failed to send/edit/followUp or handle auto-delete for interaction ${interaction.id}:`, error.message);
        // Avoid trying to reply again if the reply itself failed
    }
}

async function ensureSheetHeaders() { /* ... same as v17/full_bot_env_vars_clean_v2 ... */ }
async function authorizeGoogleAPIs() { /* ... same as v17/full_bot_env_vars_clean_v2 ... */ }
const GUILD_CONFIGS_PATH = path.join(__dirname, 'guild-configs.json');
let guildConfigs = {};
let openTickets = {};
function loadGuildConfigs() { /* ... same ... */ }
function saveGuildConfigs() { /* ... same ... */ }
function formatTimestamp(date, includeSeconds = false, dateOnly = false) { /* ... same ... */ }
async function clearSheet() { /* ... same (this is the weekly sheet-only clear) ... */ }
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
        console.error("[FATAL] Failed to authorize Google APIs. Bot functionality may be limited.");
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

    client.once(Events.ClientReady, readyClient => { /* ... same ... */ });

    client.on(Events.InteractionCreate, async interaction => {
        console.log(`[INTERACTION_DEBUG] Received interaction: Type=${interaction.type}, CustomID/CommandName=${interaction.customId || interaction.commandName}, User=${interaction.user.tag}, Guild=${interaction.guildId}`);

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
                // Pass all necessary clients and configs to the command
                await command.execute(interaction, client, guildConfigs, saveGuildConfigs, clearSheet, replyEphemeralAutoDelete, sheetsClient, driveClient, SPREADSHEET_ID, SHEET_NAME, numericSheetId);
            } catch (error) {
                console.error(`[INTERACTION_ERROR] Uncaught error executing /${interaction.commandName}:`, error);
                const errorReplyOptions = { content: 'Oops! Something went wrong while running that command.' };
                // If deferred, we MUST editReply. If already replied (e.g. by helper in command), it might fail but that's okay.
                if (interaction.deferred) {
                    console.log(`[INTERACTION_ERROR_HANDLER] Interaction was deferred, attempting editReply.`);
                    replyEphemeralAutoDelete(interaction, errorReplyOptions, false, true); // isEdit = true
                } else if (!interaction.replied) { // Only reply if no reply/defer has happened
                    console.log(`[INTERACTION_ERROR_HANDLER] Interaction not replied/deferred, attempting initial reply.`);
                    replyEphemeralAutoDelete(interaction, errorReplyOptions);
                } else {
                    console.log(`[INTERACTION_ERROR_HANDLER] Interaction already replied. No further error reply sent from global handler.`);
                }
            }
        } else if (interaction.isButton()) {
            console.log(`[INTERACTION_DEBUG] Handling ButtonInteraction: CustomID=${interaction.customId}`);
            // Ensure all button handlers call deferReply with flags if they do async work,
            // and then use replyHelper with isEdit=true or isFollowUp=true for the final response.
            if (interaction.customId === 'create_ticket_button') {
                // ... (logic from v17, ensure deferReply uses flags and final reply uses replyHelper with isEdit=true)
                // Example of how it should start:
                // if (!guildConfig) { replyEphemeralAutoDelete(interaction, { content: 'Ticket system not configured.' }); return; }
                // try {
                //     await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                //     ...
                //     replyEphemeralAutoDelete(interaction, { content: `Your ticket...` }, false, true);
                // } catch (error) {
                //     replyEphemeralAutoDelete(interaction, { content: 'Error creating ticket.' }, false, true);
                // }
            } else if (interaction.customId === 'admin_view_sheet_button') {
                 // ... (logic from v17, ensure reply uses replyHelper)
                // Example:
                // if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) { /* ... */ }
                // replyEphemeralAutoDelete(interaction, replyOptions);
            }
            // --- Make sure all button handlers acknowledge the interaction quickly ---
            // For example, the create_ticket_button logic:
            if (interaction.customId === 'create_ticket_button') {
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
                
                try {
                    console.log(`[INTERACTION_DEBUG] Deferring reply for create_ticket_button.`);
                    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); // DEFER HERE
                    console.log(`[INTERACTION_DEBUG] Reply deferred for create_ticket_button.`);

                    const userNameForChannel = member.user.username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'user';
                    const ticketChannelName = `ticket-${userNameForChannel}-${member.user.discriminator === '0' ? member.user.id.slice(-4) : member.user.discriminator}`;
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
                    
                    replyEphemeralAutoDelete(interaction, { content: `Your ticket has been created: ${ticketChannel}` }, false, true); // isEdit = true
                    console.log(`Ticket ${ticketChannel.name} created for ${member.user.tag}.`);
                    const timeoutId = setTimeout(async () => { /* ... blank ticket cleanup ... */ }, 60000);
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
                // This is a quick reply, defer might not be strictly necessary but good practice
                // await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); // Optional defer
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
                replyEphemeralAutoDelete(interaction, replyOptions); // if not deferred: false, false. If deferred: false, true
            }
        }
    });

    client.on(Events.MessageCreate, async message => { /* ... same message creation logic as v17 ... */ });
    client.on(Events.ChannelDelete, channel => { /* ... same channel delete logic as v17 ... */ });

    try {
        await client.login(TOKEN);
        console.log("Login to Discord successful!");
    } catch (error) { /* ... same login error handling ... */ }

    console.log("[INFO] Bot is running and listening for events. Process will be kept alive.");
    await new Promise(() => {});

})();

