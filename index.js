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
const SHEETS_CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

const API_SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
];

const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SUB_HEADERS = [
    'Player Display Name', 'Screenshot', 'Timestamp (UTC)',
    'Verified', 'Strikes', 'Time in Server', 'Drive File ID'
];
const ROWS_PER_DAY_BLOCK = 1 + DAY_SUB_HEADERS.length;

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
        if (isEdit) sentMessage = await interaction.editReply(currentOptions);
        else if (isFollowUp) sentMessage = await interaction.followUp(currentOptions);
        else sentMessage = await interaction.reply(currentOptions);

        if (sentMessage && typeof sentMessage.delete === 'function') {
            setTimeout(() => {
                sentMessage.delete().catch(err => {
                    if (err.code !== 10008) {
                        console.error(`[AUTO_DELETE_ERROR]`, err.message);
                    }
                });
            }, EPHEMERAL_DELETE_DELAY);
        }
    } catch (error) {
        console.error(`[REPLY_ERROR]`, error.message);
    }
}

async function ensureSheetHeadersAndStructure() {
    if (!sheetsClient || !SPREADSHEET_ID || !SHEET_NAME) return;
    try {
        const expectedColumnAValues = [];
        DAYS_OF_WEEK.forEach(day => {
            expectedColumnAValues.push(day);
            DAY_SUB_HEADERS.forEach(sub => expectedColumnAValues.push(`  ${sub}`));
        });

        const range = `'${SHEET_NAME}'!A1:A${expectedColumnAValues.length}`;
        const getResponse = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range
        });

        const existing = getResponse.data.values ? getResponse.data.values.flat() : [];
        let needsUpdate = existing.length < expectedColumnAValues.length || existing.some((val, i) => val !== expectedColumnAValues[i]);

        if (needsUpdate) {
            const values = expectedColumnAValues.map(v => [v]);
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `'${SHEET_NAME}'!A1`,
                valueInputOption: 'USER_ENTERED',
                resource: { values }
            });
        }
    } catch (error) {
        console.error(`[GSHEETS_SETUP_ERROR]`, error.message);
    }
}

async function authorizeGoogleAPIs() {
    try {
        let credentials;
        if (GOOGLE_CREDENTIALS_JSON_CONTENT) credentials = JSON.parse(GOOGLE_CREDENTIALS_JSON_CONTENT);

        googleAuthClient = new google.auth.GoogleAuth({
            credentials,
            keyFile: credentials ? undefined : SHEETS_CREDENTIALS_PATH,
            scopes: API_SCOPES
        });
        const auth = await googleAuthClient.getClient();

        sheetsClient = google.sheets({ version: 'v4', auth });
        driveClient = google.drive({ version: 'v3', auth });

        const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets(properties(sheetId,title))' });
        const target = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
        if (target) {
            numericSheetId = target.properties.sheetId;
            await ensureSheetHeadersAndStructure();
        }
        return true;
    } catch (e) {
        console.error('[GAPI_ERROR_AUTH]', e.message);
        return false;
    }
}

const GUILD_CONFIGS_PATH = path.join(__dirname, 'guild-configs.json');
let guildConfigs = {};

function loadGuildConfigs() {
    try {
        if (fs.existsSync(GUILD_CONFIGS_PATH)) {
            guildConfigs = JSON.parse(fs.readFileSync(GUILD_CONFIGS_PATH, 'utf-8'));
        }
    } catch (e) { console.error("[LOAD_CONFIG_ERROR]", e); }
}

function saveGuildConfigs() {
    try {
        fs.writeFileSync(GUILD_CONFIGS_PATH, JSON.stringify(guildConfigs, null, 2));
    } catch (e) { console.error("[SAVE_CONFIG_ERROR]", e); }
}

function formatTimestamp(date, dateOnly = false) {
    const y = String(date.getUTCFullYear()).slice(-2);
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    if (dateOnly) return `${m}-${d}-${y}`;
    const h = String(date.getUTCHours()).padStart(2, '0');
    const min = String(date.getUTCMinutes()).padStart(2, '0');
    return `${m}-${d}-${y} ${h}:${min} UTC`;
}

async function clearSheetWeekly() {
    if (!sheetsClient || !SPREADSHEET_ID || !SHEET_NAME || typeof numericSheetId === 'undefined') return false;
    try {
        const requests = [];
        for (let i = 0; i < DAYS_OF_WEEK.length; i++) {
            const startRow = (i * ROWS_PER_DAY_BLOCK) + 2;
            const endRow = startRow + DAY_SUB_HEADERS.length - 1;
            requests.push({
                updateCells: {
                    range: {
                        sheetId: numericSheetId,
                        startRowIndex: startRow - 1,
                        endRowIndex: endRow,
                        startColumnIndex: 1,
                        endColumnIndex: 2
                    },
                    rows: Array(DAY_SUB_HEADERS.length).fill({ values: [{ userEnteredValue: { stringValue: "" } }] }),
                    fields: "userEnteredValue"
                }
            });
        }
        await sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: { requests }
        });
        return true;
    } catch (error) {
        console.error('[GSHEETS_CLEAR_WEEKLY_ERROR]', error.message);
        return false;
    }
}

async function autoResizeSheetColumns() {
    if (!sheetsClient || !SPREADSHEET_ID || typeof numericSheetId === 'undefined') return;
    try {
        await sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: {
                requests: [{
                    autoResizeDimensions: {
                        dimensions: {
                            sheetId: numericSheetId,
                            dimension: "COLUMNS",
                            startIndex: 0,
                            endIndex: 2
                        }
                    }
                }]
            }
        });
    } catch (error) {
        console.error('[GSHEETS_RESIZE_ERROR]', error.message);
    }
}

(async () => {
    console.log("--- Initializing Bot ---");
    if (!TOKEN || !SPREADSHEET_ID || !DRIVE_FOLDER_ID || (!GOOGLE_CREDENTIALS_JSON_CONTENT && !fs.existsSync(SHEETS_CREDENTIALS_PATH)) || !SHEET_NAME) {
        console.error("[FATAL_CONFIG_ERROR]");
        process.exit(1);
    }
    if (!await authorizeGoogleAPIs()) {
        console.error("[FATAL] Google API authorization failed.");
    }
    loadGuildConfigs();

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessageReactions
        ],
        partials: [Partials.Message, Partials.Channel, Partials.Reaction]
    });

    client.commands = new Collection();
    const commandsPath = path.join(__dirname, 'commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
            console.log(`[CMDS] Loaded command: /${command.data.name}`);
        }
    }

    client.once(Events.ClientReady, readyClient => {
        console.log(`\nReady! Logged in as ${readyClient.user.tag}`);
        cron.schedule('0 0 * * 0', () => clearSheetWeekly(), { scheduled: true, timezone: "UTC" });
    });

    client.on(Events.InteractionCreate, async interaction => {
        if (!interaction.inGuild()) return;
        if (interaction.isChatInputCommand()) {
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) return;
            try {
                await command.execute(interaction, client, guildConfigs, saveGuildConfigs,
                                      clearSheetWeekly, replyEphemeralAutoDelete,
                                      sheetsClient, driveClient, SPREADSHEET_ID, SHEET_NAME, numericSheetId);
            } catch (error) {
                console.error(`[INTERACTION_ERROR]`, error);
                replyEphemeralAutoDelete(interaction, { content: 'An error occurred.' });
            }
        }
    });

    client.login(TOKEN);
})();

