// deploy-commands.js
const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config.json'); // Your config file for the bot token

const TOKEN = config.botToken;
const CLIENT_ID = "1373492833528315997"; // Your bot's Application (Client) ID

const commands = [];
// Grab all the command files from the commands directory
const commandsPath = path.join(__dirname, 'commands');
let commandFiles = [];
try {
    commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
} catch (error) {
    console.error(`[ERROR] Could not read commands directory at ${commandsPath}. Make sure it exists and contains command files.`, error);
    process.exit(1); // Exit if commands folder is missing
}


// Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    try {
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
            commands.push(command.data.toJSON());
            console.log(`[DEPLOY] Added command /${command.data.name} for deployment.`);
        } else {
            console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    } catch (error) {
        console.error(`[ERROR] Failed to load command at ${filePath}:`, error);
    }
}

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(TOKEN);

// Deploy your commands!
(async () => {
    if (commands.length === 0) {
        console.log("[INFO] No commands found to deploy.");
        return;
    }
    try {
        console.log(`\nStarted refreshing ${commands.length} application (/) commands globally.`);

        // The 'put' method is used to fully refresh all commands (globally or in a specific guild)
        // Routes.applicationCommands(CLIENT_ID) for global commands
        // Routes.applicationGuildCommands(CLIENT_ID, 'YOUR_TEST_GUILD_ID') for guild-specific (faster updates during dev)
        const data = await rest.put(
            Routes.applicationCommands(CLIENT_ID), // Deploying globally
            { body: commands },
        );

        console.log(`Successfully reloaded ${data.length} application (/) commands globally.`);
    } catch (error) {
        console.error("\n[ERROR] Failed to deploy application commands:");
        if (error.code === 401 || (error.rawError && error.rawError.message === 'Unauthorized')) {
             console.error("[ERROR] Unauthorized: This usually means your BOT TOKEN is invalid or missing.");
             console.error("[ERROR] Please ensure your 'config.json' has a valid 'botToken'.");
        } else if (error.code === 50035 && error.message.includes("CLIENT_ID")) {
            console.error("[ERROR] Invalid Form Body (CLIENT_ID): This usually means your CLIENT_ID is incorrect or not a snowflake.");
            console.error(`[ERROR] Check CLIENT_ID in deploy-commands.js. Currently: "${CLIENT_ID}"`);
        }
        else {
            console.error(error); // Log other types of errors
        }
    }
})();
