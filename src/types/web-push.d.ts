declare module 'web-push' {
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function sendNotification(
    subscription: any,
    payload?: string | Buffer,
    options?: any
  ): Promise<any>;
}
