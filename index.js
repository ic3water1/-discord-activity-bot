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
        if (isEdit) {
            await interaction.editReply(options);
        } else if (isFollowUp) {
            await interaction.followUp({ ...options, ephemeral: true });
        } else {
            await interaction.reply({ ...options, ephemeral: true });
        }
        setTimeout(() => interaction.deleteReply().catch(() => {}), EPHEMERAL_DELETE_DELAY);
    } catch (error) {
        console.error('Error in replyEphemeralAutoDelete:', error);
    }
}

async function ensureSheetHeaders() {
    try {
        const res = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!1:1`
        });
        
        const existingHeaders = res.data.values?.[0] || [];
        
        if (JSON.stringify(existingHeaders) !== JSON.stringify(EXPECTED_HEADERS)) {
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!1:1`,
                valueInputOption: 'RAW',
                resource: { values: [EXPECTED_HEADERS] }
            });
            console.log('Sheet headers updated successfully');
        }
    } catch (error) {
        console.error('Error ensuring sheet headers:', error);
        throw error;
    }
}

async function authorizeGoogleAPIs() {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(GOOGLE_CREDENTIALS_JSON_CONTENT),
            scopes: API_SCOPES
        });
        googleAuthClient = await auth.getClient();
        sheetsClient = google.sheets({ version: 'v4', auth: googleAuthClient });
        driveClient = google.drive({ version: 'v3', auth: googleAuthClient });
        
        // Verify access by making a test request
        await sheetsClient.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        return true;
    } catch (error) {
        console.error('Google API Authorization Error:', error);
        return false;
    }
}

const GUILD_CONFIGS_PATH = path.join(__dirname, 'guild-configs.json');
let guildConfigs = {};
let openTickets = {};

function loadGuildConfigs() {
    try {
        if (fs.existsSync(GUILD_CONFIGS_PATH)) {
            guildConfigs = JSON.parse(fs.readFileSync(GUILD_CONFIGS_PATH));
            console.log('Loaded guild configurations');
        }
    } catch (error) {
        console.error('Error loading guild configs:', error);
    }
}

function saveGuildConfigs() {
    try {
        fs.writeFileSync(GUILD_CONFIGS_PATH, JSON.stringify(guildConfigs, null, 2));
    } catch (error) {
        console.error('Error saving guild configs:', error);
    }
}

function formatTimestamp(date, includeSeconds = false, dateOnly = false) {
    const options = {
        month: '2-digit',
        day: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    };
    
    if (dateOnly) {
        return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear().toString().slice(-2)}`;
    }
    
    if (includeSeconds) {
        options.second = '2-digit';
    }
    
    return date.toLocaleString('en-US', options).replace(',', '');
}

async function clearSheetWeekly() {
    try {
        const now = new Date();
        const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const lastWeekFormatted = formatTimestamp(lastWeek, false, true);
        
        const response = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A2:I`
        });
        
        const rows = response.data.values || [];
        const rowsToKeep = rows.filter(row => {
            const rowDate = row[TIMESTAMP_COLUMN_INDEX];
            return rowDate && rowDate >= lastWeekFormatted;
        });
        
        await sheetsClient.spreadsheets.values.clear({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A2:I`
        });
        
        if (rowsToKeep.length > 0) {
            await sheetsClient.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A2:I`,
                valueInputOption: 'RAW',
                resource: { values: rowsToKeep }
            });
        }
        
        console.log('Weekly sheet cleanup completed');
    } catch (error) {
        console.error('Error during weekly sheet cleanup:', error);
    }
}

async function autoResizeSheetColumns() {
    try {
        await sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: {
                requests: [{
                    autoResizeDimensions: {
                        dimensions: {
                            sheetId: numericSheetId,
                            dimension: 'COLUMNS',
                            startIndex: 0,
                            endIndex: EXPECTED_HEADERS.length
                        }
                    }
                }]
            }
        });
    } catch (error) {
        console.error('Error auto-resizing columns:', error);
    }
}

function formatDuration(ms, short = false) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (short) {
        return `${days}d ${hours % 24}h ${minutes % 60}m`;
    }
    
    const parts = [];
    if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
    if (hours % 24 > 0) parts.push(`${hours % 24} hour${hours % 24 !== 1 ? 's' : ''}`);
    if (minutes % 60 > 0) parts.push(`${minutes % 60} minute${minutes % 60 !== 1 ? 's' : ''}`);
    
    return parts.join(', ') || 'less than a minute';
}

async function updatePromptMessage(guildId, messageId, channelId, clientInstance) {
    try {
        const guild = clientInstance.guilds.cache.get(guildId);
        if (!guild) return;
        
        const channel = guild.channels.cache.get(channelId);
        if (!channel) return;
        
        const message = await channel.messages.fetch(messageId);
        if (!message) return;
        
        const config = guildConfigs[guildId];
        if (!config) return;
        
        const embed = new MessageEmbed()
            .setTitle('Ticket System')
            .setDescription(config.promptMessage || 'Click the button below to create a ticket')
            .setColor('#0099ff');
            
        await message.edit({ embeds: [embed], components: [/* your action row components here */] });
    } catch (error) {
        console.error(`Error updating prompt message in guild ${guildId}:`, error);
    }
}

async function updateAllPromptMessages(clientInstance) {
    try {
        for (const [guildId, config] of Object.entries(guildConfigs)) {
            if (config.promptMessageId && config.ticketChannelId) {
                await updatePromptMessage(guildId, config.promptMessageId, config.ticketChannelId, clientInstance)
                    .catch(error => console.error(`Error updating prompt for guild ${guildId}:`, error));
            }
        }
    } catch (error) {
        console.error('Error updating all prompt messages:', error);
    }
}

// Process event handlers for graceful shutdown
process.on('SIGINT', () => {
    console.log('Received SIGINT. Shutting down gracefully...');
    if (client) client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Shutting down gracefully...');
    if (client) client.destroy();
    process.exit(0);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

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
        console.error("[FATAL_EXIT] Failed to authorize Google APIs. Bot cannot continue with full functionality. Exiting.");
        process.exit(1);
    }
    
    loadGuildConfigs();
    await ensureSheetHeaders();

    const intentsArray = [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions
    ];

    const client = new Client({
        intents: intentsArray,
        partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });

    client.updatePromptMessage = updatePromptMessage;
    client.commands = new Collection();
    
    // Load commands
    const commandsPath = path.join(__dirname, 'commands');
    try {
        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            const command = require(filePath);
            client.commands.set(command.data.name, command);
            console.log(`Loaded command ${command.data.name}`);
        }
    } catch (error) {
        console.error('Error loading commands:', error);
    }

    client.once(Events.ClientReady, readyClient => {
        console.log(`Logged in as ${readyClient.user.tag}`);
        
        // Schedule weekly sheet cleanup
        cron.schedule('0 0 * * 0', () => clearSheetWeekly(), {
            timezone: 'UTC'
        });
        
        // Update all prompt messages
        updateAllPromptMessages(readyClient).catch(console.error);
    });

    client.on(Events.InteractionCreate, async interaction => {
        if (!interaction.isCommand()) return;
        
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(`Error executing command ${interaction.commandName}:`, error);
            await replyEphemeralAutoDelete(interaction, {
                content: 'There was an error while executing this command!',
            });
        }
    });

    client.on(Events.MessageCreate, async message => {
        // Handle message creation events here
    });

    client.on(Events.ChannelDelete, channel => {
        // Handle channel deletion events here
    });

    try {
        await client.login(TOKEN);
        console.log("Login to Discord successful!");
    } catch (error) {
        console.error("\n[FATAL ERROR] Failed to log in to Discord:", error.message);
        if (error.code === 'ClientMissingIntents') {
            console.error("[FATAL_LOGIN_ERROR] ClientMissingIntents error during login. Check intentsArray and GatewayIntentBits values logged above.");
        } else if (error.code === 'DisallowedIntents') {
            console.error("[FATAL_LOGIN_ERROR] Privileged Gateway Intents likely missing or disabled for your bot in the Discord Developer Portal.");
        } else if (error.message.includes("TOKEN_INVALID") || (error.rawError && error.rawError.message === 'Unauthorized')) {
            console.error("[FATAL_LOGIN_ERROR] The BOT TOKEN is invalid or missing. Check your environment variable.");
        } else {
            console.error("[FATAL_LOGIN_ERROR] An unexpected error occurred during login:", error);
        }
        process.exit(1);
    }

    console.log("[INFO] Bot is running and listening for events.");
})();
