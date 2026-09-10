import { MongoClient, type Db } from "mongodb";
import { config } from "./config";

const client = new MongoClient(config.mongoUri);

let db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (!db) {
    await client.connect();
    db = client.db(config.dbName);
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await client.close();
    db = null;
  }
}
