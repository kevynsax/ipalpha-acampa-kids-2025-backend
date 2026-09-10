import { ObjectId } from "mongodb";
import { SignJWT, jwtVerify } from "jose";
import { config } from "../config";
import { getDb } from "../db";
import type { Role, Session } from "../types";

const secret = new TextEncoder().encode(config.jwtSecret);

export async function createSession(
  userId: string,
  role: Session["role"],
): Promise<{ token: string; session: Session }> {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionHours * 60 * 60 * 1000);

  const { insertedId } = await db.collection("sessions").insertOne({
    userId,
    role,
    createdAt: now,
    expiresAt,
  });

  const session: Session = {
    _id: insertedId.toString(),
    userId,
    role,
    createdAt: now,
    expiresAt,
  };

  const token = await new SignJWT({
    sid: session._id,
    role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret);

  return { token, session };
}

export async function verifySessionToken(
  token: string,
): Promise<{ userId: string; sessionId: string; role: Role } | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (!payload.sub || typeof payload.sid !== "string") return null;

    // make sure the session still exists and hasn't expired
    const db = await getDb();
    const session = await db.collection("sessions").findOne({
      _id: new ObjectId(payload.sid),
    });

    if (!session) return null;
    if (session.expiresAt <= new Date()) {
      await db.collection("sessions").deleteOne({ _id: session._id });
      return null;
    }

    return { userId: payload.sub, sessionId: payload.sid, role: session.role as Role };
  } catch {
    return null;
  }
}

export async function revokeSession(sessionId: string): Promise<void> {
  const db = await getDb();
  await db.collection("sessions").deleteOne({ _id: new ObjectId(sessionId) });
}
