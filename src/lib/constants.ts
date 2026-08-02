export const PRAVA_API_BASE = process.env.PRAVA_API_BASE || 'https://api.prava.space';

export const CATEGORY_MAP: Record<string, string[]> = {
  'Language Learning': ['Duolingo', 'Babbel', 'Busuu', 'Rosetta Stone'],
  'Video Recording': ['Loom', 'Screen Studio', 'Tella', 'ScreenPal'],
  'Note Taking': ['Notion', 'Obsidian', 'Coda', 'Roam'],
  'Design': ['Canva', 'Figma', 'Adobe Creative Cloud', 'Affinity'],
  'Writing': ['Grammarly', 'LanguageTool', 'ProWritingAid'],
  'Music Streaming': ['Spotify', 'Apple Music', 'YouTube Music'],
  'Video Streaming': ['Netflix', 'Disney+', 'HBO Max'],
  'Cloud Storage': ['iCloud+', 'Google One', 'Dropbox'],
  'Code Editor': ['Cursor', 'GitHub Copilot', 'Codeium'],
  'Dev Tools': ['Vercel', 'Supabase', 'PlanetScale'],
  'Project Management': ['Linear', 'Jira', 'Asana'],
};

export const PRICE_HIKE_THRESHOLD = 0.05;
export const UNUSED_DAYS_THRESHOLD = 30;
export const PRAVA_SESSION_TTL_MINUTES = 15;
export const DEFAULT_CURRENCY = 'USD';
export const DEMO_USER_ID = 'subshield_demo_user_001';
export const DEMO_USER_EMAIL = 'demo@subshield.app';
