import { Schema, model } from 'mongoose';

const idempotencySchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, required: true },
    route: { type: String, required: true },
    key: { type: String, required: true },
    requestHash: { type: String, required: true },
    state: { type: String, enum: ['IN_PROGRESS', 'DONE'], required: true },
    // Reference to the result, not the result body: replays re-read with current authorization.
    operationRef: { type: Schema.Types.Mixed, default: null },
    responseStatus: { type: Number, default: null },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, collection: 'idempotencyKeys' },
);

idempotencySchema.index({ actorId: 1, route: 1, key: 1 }, { unique: true });
idempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyKey = model('IdempotencyKey', idempotencySchema);
