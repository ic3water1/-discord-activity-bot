console.log("--- index.js script started ---");

const { Client, GatewayIntentBits, Events, Partials, Collection, EmbedBuilder } = require('discord.js');
const TOKEN = process.env.BOT_TOKEN;
const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');
const cron = require('node-cron');

// Constants for spreadsheet structure
const DAYS_OF_WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SUB_HEADERS = ['Morning', 'Afternoon', 'Evening'];
const ROWS_PER_DAY_BLOCK = DAY_SUB_HEADERS.length + 1; // +1 for day header

// Validate environment variables
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const GOOGLE_CREDENTIALS_JSON_CONTENT = process.env.GOOGLE_CREDENTIALS_JSON;

if (!TOKEN || !SPREADSHEET_ID || !DRIVE_FOLDER_ID || !GOOGLE_CREDENTIALS_JSON_CONTENT) {
    console.error("[FATAL_CONFIG_ERROR] Missing required environment variables");
    process.exit(1);
}

const API_SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
];

let sheetsClient, driveClient, numericSheetId;

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
        const spreadsheetMeta = await sheetsClient.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID,
            fields: 'sheets(properties(sheetId,title))'
        });
        
        const targetSheet = spreadsheetMeta.data.sheets.find(s => s.properties.title === SHEET_NAME);
        if (!targetSheet) {
            console.error(`Sheet '${SHEET_NAME}' not found in spreadsheet`);
            return false;
        }
        
        numericSheetId = targetSheet.properties.sheetId;
        return true;
    } catch (error) {
        console.error('Google API Authorization Error:', error);
        return false;
    }
}

async function ensureSheetHeadersAndStructure() {
    try {
        const expectedColumnAValues = [];
        DAYS_OF_WEEK.forEach(day => {
            expectedColumnAValues.push(day);
            DAY_SUB_HEADERS.forEach(subHeader => {
                expectedColumnAValues.push(`  ${subHeader}`);
            });
        });

        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${SHEET_NAME}'!A1`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: expectedColumnAValues.map(val => [val]) }
        });
        
        console.log('Sheet headers updated successfully');
        return true;
    } catch (error) {
        console.error('Error ensuring sheet headers:', error);
        return false;
    }
}

async function clearSheetWeekly() {
    try {
        const rangesToClear = DAYS_OF_WEEK.map((_, i) => {
            const startRow = (i * ROWS_PER_DAY_BLOCK) + 2;
            const endRow = startRow + DAY_SUB_HEADERS.length - 1;
            return `'${SHEET_NAME}'!B${startRow}:B${endRow}`;
        });

        await sheetsClient.spreadsheets.values.batchClear({
            spreadsheetId: SPREADSHEET_ID,
            resource: { ranges: rangesToClear }
        });

        console.log('Weekly sheet cleanup completed');
        return true;
    } catch (error) {
        console.error('Error during weekly sheet cleanup:', error);
        return false;
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
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// Command handling
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');

try {
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
        const command = require(path.join(commandsPath, file));
        if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
            console.log(`Loaded command ${command.data.name}`);
        }
    }
} catch (error) {
    console.error('Error loading commands:', error);
}

// Event handlers
client.once(Events.ClientReady, async readyClient => {
    console.log(`Logged in as ${readyClient.user.tag}`);
    
    try {
        // Initialize scheduled tasks
        cron.schedule('0 0 * * 0', () => {
            console.log('Running weekly cleanup...');
            clearSheetWeekly().catch(console.error);
        }, {
            timezone: 'Etc/UTC',
            scheduled: true
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
        await interaction.deferReply({ ephemeral: true });
        await command.execute(interaction);
    } catch (error) {
        console.error(`Error executing ${interaction.commandName}:`, error);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({
                    content: 'An error occurred!',
                    ephemeral: true
                });
            } else {
                await interaction.reply({
                    content: 'An error occurred!',
                    ephemeral: true
                });
            }
        } catch (err) {
            console.error('Failed to send error message:', err);
        }
    }
});

// Process management
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

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});

// Startup sequence
(async () => {
    try {
        console.log("Initializing Bot...");
        
        if (!await authorizeGoogleAPIs()) {
            throw new Error('Failed to authorize Google APIs');
        }

        if (!await ensureSheetHeadersAndStructure()) {
            throw new Error('Failed to initialize sheet structure');
        }

        await client.login(TOKEN);
        console.log("Bot is running");
    } catch (error) {
        console.error("Fatal startup error:", error);
        process.exit(1);
    }
})();
