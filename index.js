// index.js - FOCUSED ENVIRONMENT VARIABLE TEST

console.log("--- Fly.io Environment Variable Test Script Started ---");

console.log("\nChecking critical environment variables directly from process.env:");
console.log(`1. BOT_TOKEN: Value is "${process.env.BOT_TOKEN}", Exists: ${!!process.env.BOT_TOKEN}`);
console.log(`2. SPREADSHEET_ID: Value is "${process.env.SPREADSHEET_ID}", Exists: ${!!process.env.SPREADSHEET_ID}`);
console.log(`3. SHEET_NAME: Value is "${process.env.SHEET_NAME}", Exists: ${!!process.env.SHEET_NAME} (Defaults to 'Sheet1' if not set)`);
console.log(`4. GOOGLE_DRIVE_FOLDER_ID: Value is "${process.env.GOOGLE_DRIVE_FOLDER_ID}", Exists: ${!!process.env.GOOGLE_DRIVE_FOLDER_ID}`);
console.log(`5. GOOGLE_CREDENTIALS_JSON: Value is "${process.env.GOOGLE_CREDENTIALS_JSON ? 'Exists (has content)' : 'NOT SET or Empty'}", Exists: ${!!process.env.GOOGLE_CREDENTIALS_JSON}`);

console.log("\nDerived constants check:");
const TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID_CONST = process.env.SPREADSHEET_ID;
const DRIVE_FOLDER_ID_CONST = process.env.GOOGLE_DRIVE_FOLDER_ID;
const GOOGLE_CREDENTIALS_JSON_CONTENT_CONST = process.env.GOOGLE_CREDENTIALS_JSON;

if (!TOKEN || !SPREADSHEET_ID_CONST || !DRIVE_FOLDER_ID_CONST || !GOOGLE_CREDENTIALS_JSON_CONTENT_CONST) {
    console.error("[FATAL_CONFIG_ERROR_TEST] One or more critical environment variables are effectively not set based on constants.");
    console.log(`    TOKEN constant is: ${TOKEN ? 'SET' : 'NOT SET'}`);
    console.log(`    SPREADSHEET_ID_CONST is: ${SPREADSHEET_ID_CONST ? 'SET' : 'NOT SET'}`);
    console.log(`    DRIVE_FOLDER_ID_CONST is: ${DRIVE_FOLDER_ID_CONST ? 'SET' : 'NOT SET'}`);
    console.log(`    GOOGLE_CREDENTIALS_JSON_CONTENT_CONST is: ${GOOGLE_CREDENTIALS_JSON_CONTENT_CONST ? 'SET (has content)' : 'NOT SET (empty or undefined)'}`);
} else {
    console.log("[SUCCESS_CONFIG_TEST] All critical environment variables appear to be set correctly based on constants!");
}

console.log("\n--- Fly.io Environment Variable Test Script Finished ---");
process.exit(0); // Exit cleanly after the test

