export async function createStagehandBrowser() {
  const { Stagehand } = await import('@browserbasehq/stagehand');
  const useOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const stagehand = new Stagehand({
    env: 'BROWSERBASE',
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    modelName: useOpenAI ? 'gpt-4o' : (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'),
    modelClientOptions: useOpenAI
      ? { apiKey: process.env.OPENAI_API_KEY }
      : { apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' },
    logger: () => {},
  });
  await stagehand.init();
  return stagehand;
}

export async function navigateToVendorCancellation(
  stagehand: any,
  vendor: string,
  domain: string
): Promise<{ offerFound: boolean; discountedPrice?: number; offerText?: string }> {
  const page = stagehand.page;
  
  try {
    await page.goto(`https://${domain}`);
    
    // Attempt to navigate to cancellation flow
    await (stagehand.page as any).act({
      action: 'Find and click the account or settings page, then find and click the cancel subscription button. If asked for a reason, select "too expensive" or similar.',
    });

    // Check for retention offer
    const offer = await (stagehand.page as any).extract({
      instruction: 'Look for any retention offer, discount, or deal presented to prevent cancellation. Extract the details.',
      schema: {
        type: 'object',
        properties: {
          offerFound: { type: 'boolean' },
          discountedPrice: { type: 'number' },
          offerText: { type: 'string' },
        },
        required: ['offerFound'],
      },
    });

    return offer;
  } catch (error) {
    console.error('Stagehand automation failed:', error);
    throw error;
  }
}
