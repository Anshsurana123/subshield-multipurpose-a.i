import OpenAI from 'openai';

let openaiClient: OpenAI | null = null;
let groqClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

function getGroqClient(): OpenAI | null {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  if (!groqClient) {
    groqClient = new OpenAI({
      apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }
  return groqClient;
}

/**
 * Creates a chat completion with automatic fallback to Groq API when OpenAI is
 * unavailable, unconfigured, or out of credits/quota.
 */
export async function createChatCompletion(
  params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const openai = getOpenAIClient();
  const groq = getGroqClient();

  if (openai) {
    try {
      return await openai.chat.completions.create(params);
    } catch (err: any) {
      const errorMessage = String(err?.message || err);
      console.warn(`[AIClient] OpenAI call failed (${errorMessage}).`);

      if (groq) {
        console.log('[AIClient] Falling back to Groq API...');
        const groqModel = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
        return await groq.chat.completions.create({
          ...params,
          model: groqModel,
        });
      }
      throw err;
    }
  }

  if (groq) {
    console.log('[AIClient] OpenAI API key not present. Using Groq API...');
    const groqModel = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    return await groq.chat.completions.create({
      ...params,
      model: groqModel,
    });
  }

  throw new Error('No AI provider configured (neither OPENAI_API_KEY nor GROQ_API_KEY set).');
}
