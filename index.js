console.log("--- index.js script started ---");

const { Client, GatewayIntentBits, Events, Partials, Collection, EmbedBuilder } = require('discord.js');
const TOKEN = process.env.BOT_TOKEN;
const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');
const cron = require('node-cron');

// Validate critical environment variables
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const GOOGLE_CREDENTIALS_JSON_CONTENT = process.env.GOOGLE_CREDENTIALS_JSON;

if (!TOKEN || !SPREADSHEET_ID || !DRIVE_FOLDER_ID || !GOOGLE_CREDENTIALS_JSON_CONTENT) {
    console.error("[FATAL_CONFIG_ERROR] Missing required environment variables");
    console.log(`  BOT_TOKEN present: ${!!TOKEN}`);
    console.log(`  SPREADSHEET_ID present: ${!!SPREADSHEET_ID}`);
    console.log(`  DRIVE_FOLDER_ID present: ${!!DRIVE_FOLDER_ID}`);
    console.log(`  GOOGLE_CREDENTIALS_JSON present: ${!!GOOGLE_CREDENTIALS_JSON_CONTENT}`);
    process.exit(1);
}

const API_SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
];

let sheetsClient, driveClient;

async function authorizeGoogleAPIs() {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(GOOGLE_CREDENTIALS_JSON_CONTENT),
            scopes: API_SCOPES
        });
        
        const authClient = await auth.getClient();
        sheetsClient = google.sheets({ version: 'v4', auth: authClient });
        driveClient = google.drive({ version: 'v3', auth: authClient });
        
        // Test the connection
        await sheetsClient.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        return true;
    } catch (error) {
        console.error('Google API Authorization Error:', error);
        return false;
    }
}

// Initialize Discord client with proper intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// Command handling
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    client.commands.set(command.data.name, command);
    console.log(`Loaded command ${command.data.name}`);
}

// Improved interaction handling
client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
        await interaction.deferReply({ ephemeral: true });
        await command.execute(interaction);
    } catch (error) {
        console.error(`Error executing ${interaction.commandName}:`, error);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({
                    content: 'An error occurred while executing this command!',
                    ephemeral: true
                });
            } else {
                await interaction.reply({
                    content: 'An error occurred while executing this command!',
                    ephemeral: true
                });
            }
        } catch (err) {
            console.error('Failed to send error message:', err);
        }
    }
});

// Initialize scheduled tasks with error handling
function initializeScheduledTasks() {
    try {
        const job = cron.schedule('0 0 * * 0', () => {
            console.log('Running weekly cleanup...');
            // Add your cleanup logic here
        }, {
            timezone: 'Etc/UTC',
            scheduled: true
        });
        job.start();
    } catch (error) {
        console.error('Failed to schedule tasks:', error);
    }
}

// Client ready event
client.once(Events.ClientReady, async readyClient => {
    console.log(`Logged in as ${readyClient.user.tag}`);
    initializeScheduledTasks();
});

// Graceful shutdown handling
process.on('SIGINT', async () => {
    console.log('Received SIGINT. Shutting down gracefully...');
    try {
        if (client && client.destroy) {
            await client.destroy();
        }
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    console.log('Received SIGTERM. Shutting down gracefully...');
    try {
        if (client && client.destroy) {
            await client.destroy();
        }
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});

// Global error handlers
process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});

// Main startup sequence
(async () => {
    try {
        console.log("--- Initializing Bot ---");
        
        // Initialize Google APIs
        const googleAuthSuccess = await authorizeGoogleAPIs();
        if (!googleAuthSuccess) {
            throw new Error('Failed to initialize Google APIs');
        }

        // Start Discord client
        await client.login(TOKEN);
        console.log("Bot is running and listening for events");
    } catch (error) {
        console.error("Fatal startup error:", error);
        process.exit(1);
    }
})();
