import { Schema, model, InferSchemaType } from 'mongoose';

export const SETTINGS_ID = 'global';

const settingsSchema = new Schema(
  {
    _id: { type: String, default: SETTINGS_ID },
    timezone: { type: String, required: true },
    followUp: {
      enabled: { type: Boolean, default: true },
      intervalDays: { type: Number, default: 30 },
      reminderTime: { type: String, default: '10:00' },
      repeatFollowUps: { type: Boolean, default: false },
      unreachableRetryDays: { type: Number, default: 3 },
      maxUnreachableAttempts: { type: Number, default: 3 },
    },
    backup: {
      enabled: { type: Boolean, default: true },
      scheduleTime: { type: String, default: '02:00' },
      retentionCount: { type: Number, default: 30 },
    },
    // Touched by admin-protection transactions to serialize "last active admin" checks.
    adminLockAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'settings' },
);

export type SettingsDoc = InferSchemaType<typeof settingsSchema>;
export const Settings = model('Settings', settingsSchema);
