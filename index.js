console.log("--- index.js script started ---");

const { Client, GatewayIntentBits, Events, Partials, Collection, EmbedBuilder } = require('discord.js');
const TOKEN = process.env.BOT_TOKEN;
const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');
const cron = require('node-cron');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const GOOGLE_CREDENTIALS_JSON_CONTENT = process.env.GOOGLE_CREDENTIALS_JSON;

const API_SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
];

// Initialize clients
let sheetsClient, driveClient, googleAuthClient;

async function authorizeGoogleAPIs() {
    try {
        if (!GOOGLE_CREDENTIALS_JSON_CONTENT) {
            throw new Error('Google credentials JSON content is missing');
        }

        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(GOOGLE_CREDENTIALS_JSON_CONTENT),
            scopes: API_SCOPES
        });
        
        googleAuthClient = await auth.getClient();
        sheetsClient = google.sheets({ version: 'v4', auth: googleAuthClient });
        driveClient = google.drive({ version: 'v3', auth: googleAuthClient });
        
        // Verify access
        await sheetsClient.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        return true;
    } catch (error) {
        console.error('Google API Authorization Error:', error);
        return false;
    }
}

// Improved error handling for interactions
async function handleInteractionError(interaction, error) {
    console.error(`Error in interaction ${interaction.commandName}:`, error);
    
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

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel]
});

// Load commands
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    client.commands.set(command.data.name, command);
    console.log(`Loaded command ${command.data.name}`);
}

// Client events
client.once(Events.ClientReady, async readyClient => {
    console.log(`Logged in as ${readyClient.user.tag}`);
    
    try {
        // Initialize scheduled tasks with proper error handling
        cron.schedule('0 0 * * 0', () => {
            console.log('Running weekly cleanup...');
            // Add your cleanup logic here
        }, {
            timezone: 'UTC',
            scheduled: true,
            recoverMissedExecutions: false
        });
    } catch (error) {
        console.error('Failed to schedule tasks:', error);
    }
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
        // Defer reply to avoid timeout
        await interaction.deferReply({ ephemeral: true });
        
        // Execute command
        await command.execute(interaction);
    } catch (error) {
        await handleInteractionError(interaction, error);
    }
});

// Error handling
process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});

// Startup sequence
(async () => {
    try {
        // Validate environment variables
        if (!TOKEN || !SPREADSHEET_ID || !DRIVE_FOLDER_ID || !GOOGLE_CREDENTIALS_JSON_CONTENT) {
            throw new Error('Missing required environment variables');
        }

        // Initialize Google APIs
        const googleAuthSuccess = await authorizeGoogleAPIs();
        if (!googleAuthSuccess) {
            throw new Error('Failed to initialize Google APIs');
        }

        // Start Discord client
        await client.login(TOKEN);
        console.log('Bot is running and listening for events');
    } catch (error) {
        console.error('Fatal startup error:', error);
        process.exit(1);
    }
})();
