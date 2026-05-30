// LOCAL ONLY — gitignored. Optional: seed a default AI key so auto-naming works
// without opening Preferences. Leave aiKey empty to disable. The app works fine
// without this file (paste a key in Preferences → Voice instead).
window.__DISCOVIBE_DEFAULTS = {
  aiKey: '',   // paste a Gemini / OpenRouter / Groq key here if you want a baked-in default
  aiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  aiModel: 'gemini-2.0-flash'
};
