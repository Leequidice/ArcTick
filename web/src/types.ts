export type Market = { slotId: string; kind: "virtual" | "live"; address?: string; assetPair: string; feedAddress: string; price: string; priceUpdatedAt: string; startTime?: string; endTime?: string; duration: string; timeRemaining: number; yesPool: string; noPool: string; yesParticipants: string; noParticipants: string };
export type Session = { token: string; address: string; custodial: boolean };
export type Comment = { id: string; address: string; text: string; createdAt: string };
