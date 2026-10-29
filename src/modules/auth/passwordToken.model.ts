import { Schema, model } from 'mongoose';

export const TOKEN_PURPOSES = ['SETUP', 'RESET'] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

const passwordTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: TOKEN_PURPOSES, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdAt: { type: Date, required: true },
  },
  { versionKey: false, collection: 'passwordTokens' },
);

passwordTokenSchema.index({ tokenHash: 1 }, { unique: true });
passwordTokenSchema.index({ userId: 1, consumedAt: 1 });
passwordTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export const PasswordToken = model('PasswordToken', passwordTokenSchema);
