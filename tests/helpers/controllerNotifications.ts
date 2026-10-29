export interface NotificationCondition {
  conditionId: string;
  message: string;
}

export interface NotificationSource {
  current(): NotificationCondition | null;
  subscribe(listener: (condition: NotificationCondition) => void): () => void;
}
