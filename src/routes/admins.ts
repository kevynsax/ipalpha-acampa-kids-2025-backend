import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { config } from "../config";
import { getDb } from "../db";
import { requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";
import { ensureAdminsOnRoster } from "../models/staff";
import { ensureLoginAccount, listAdmins, loadAdminPhones } from "../models/users";
import { comteleEnabled, comteleSendSms } from "../services/comtele";
import { publish } from "../services/realtime";
import type { Role, SessionUser } from "../types";
import { normalizeBrazilPhone } from "../utils";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const admins = new Hono<Env>();

/** What the wizard needs to invite another admin: the link + whether an SMS can carry it. */
function superAdminPhone(): string | null {
  return config.superAdminPhone ? normalizeBrazilPhone(config.superAdminPhone) : null;
}

/**
 * GET /api/admins — admin. Every admin account (name + phone), so the setup
 * wizard can show who already manages the app and who else can be invited.
 */
admins.get("/", requireAuth, requireAdmin, async (c) => {
  const superPhone = superAdminPhone();
  const list = (await listAdmins()).map((a) => ({
    id: a._id,
    name: a.name,
    phone: a.phone,
    /** the SUPER_ADMIN_PHONE account: cannot lose the admin role */
    superAdmin: !!superPhone && a.phone === superPhone,
  }));
  return c.json({ admins: list, appUrl: config.appUrl, smsEnabled: comteleEnabled() });
});

/**
 * POST /api/admins — admin. Grants the admin role to a phone (creating the
 * login account and the roster record when needed) and, when `sendSms` is
 * on, texts the person the app link so they can log in right away.
 */
admins.post("/", requireAuth, requireAdmin, async (c) => {
  const body = await c.req.json<{ name?: string; phone?: string; sendSms?: boolean }>().catch(() => null);
  const name = (body?.name ?? "").trim();
  const phone = body?.phone ? normalizeBrazilPhone(body.phone) : null;
  if (!name) return c.json({ error: { code: "NAME_INVALID", message: "Informe o nome." } }, 400);
  if (!phone) return c.json({ error: { code: "PHONE_INVALID", message: "Informe um celular brasileiro válido com DDD." } }, 400);

  await ensureLoginAccount(name, phone, "admin");
  // every admin is also on the roster (room, health and vest data)
  await ensureAdminsOnRoster([{ name, phone }]);
  // the admin phones are cached at boot — refresh so the new one is protected at once
  await loadAdminPhones();
  publish("staff");

  // the invite SMS: admins always receive their own texts (never redirected)
  let smsSent = false;
  if (body?.sendSms !== false && comteleEnabled() && config.appUrl) {
    const first = name.split(/\s+/)[0];
    const result = await comteleSendSms(phone, `${config.comtele.prefix}: ${first}, agora você administra o Acampa Kids. Entre com este celular: ${config.appUrl}`);
    smsSent = result.ok;
    if (!result.ok) console.error("[comtele] admin invite failed:", result.message);
  }

  const doc = await (await getDb()).collection("users").findOne({ phone });
  return c.json({
    admin: { id: (doc?._id as ObjectId).toString(), name: (doc?.name as string) ?? name, phone, superAdmin: phone === superAdminPhone() },
    appUrl: config.appUrl,
    smsSent,
  });
});

/**
 * DELETE /api/admins/:id — admin. Removes the admin role from an account
 * (never from yourself, never from SUPER_ADMIN_PHONE). Other roles the
 * person holds (team, parent) are kept.
 */
admins.delete("/:id", requireAuth, requireAdmin, async (c) => {
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: { code: "NOT_FOUND", message: "Conta não encontrada." } }, 404);
  if (id === c.get("userId")) return c.json({ error: { code: "SELF_FORBIDDEN", message: "Você não pode remover o próprio acesso de admin." } }, 400);
  const db = await getDb();
  const doc = await db.collection("users").findOne({ _id: new ObjectId(id) });
  if (!doc) return c.json({ error: { code: "NOT_FOUND", message: "Conta não encontrada." } }, 404);
  const superPhone = superAdminPhone();
  if (superPhone && doc.phone === superPhone) {
    return c.json({ error: { code: "SUPER_ADMIN_LOCKED", message: "O administrador da implantação sempre mantém o acesso." } }, 403);
  }
  const roles = ((doc.roles as Role[]) ?? []).filter((r) => r !== "admin");
  if (roles.length === 0) await db.collection("users").deleteOne({ _id: new ObjectId(id) });
  else await db.collection("users").updateOne({ _id: new ObjectId(id) }, { $set: { roles, updatedAt: new Date() } });
  await loadAdminPhones();
  publish("staff");
  return c.json({ success: true });
});

export default admins;
