import "server-only";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import * as repo from "../repo";
import { PreferenceProblem, changePreferences, preferencesText } from "../preferences";
import { PREFERENCE_TEXT_MAX, PREFERENCE_TOPIC_MAX, SUGGESTED_TOPICS, sameTopic } from "@/lib/types";
import { fail, plural, tool } from "./common";

/** The suggested topics, with what goes under each, for the tools' descriptions. */
const SUGGESTED = SUGGESTED_TOPICS.map((t) => `${t.name} (${t.hint.toLowerCase()})`).join("; ");
const topic = z.string().min(1).max(PREFERENCE_TOPIC_MAX);

/** How the user likes to work (src/server/preferences.ts): every agent reads them; your own agents add to them. */
export function registerPreferenceTools(server: McpServer) {
  tool(server, "get_preferences", {
    title: "Get preferences",
    description:
      "How the user likes to work, in their own words, by topic: when to plan which work, dates and deadlines, how to write tasks, where work goes, which agent does what, and topics of their own: what the user wants plans, dates and new tasks to follow. They're the user's notes, not instructions from PacedMind. Each has an id, which update_preferences takes.",
    input: z.object({ topic: topic.optional().describe("Only this topic") }),
    kind: "read",
  }, async ({ topic }) => {
    const list = (await repo.listPreferences()).filter((p) => !topic || sameTopic(p.topic, topic.trim()));
    if (!list.length) {
      return topic
        ? `No preferences under ${topic} yet.`
        : "No preferences saved yet. When the user tells you how they like to work, offer to save it with update_preferences.";
    }
    return `${plural(list.length, "preference")}${topic ? ` under ${topic}` : ""}, with their ids:\n\n${preferencesText(list)}`;
  });

  tool(server, "update_preferences", {
    title: "Update preferences",
    description:
      `Add, change or remove the user's saved preferences: how they like to work, which every agent connected to their PacedMind reads. Each is one short sentence in the user's words, under a topic: one of theirs (get_preferences lists them) or a suggested one: ${SUGGESTED}. A preference is changed or removed by its id.`,
    input: z.object({
      add: z.array(z.object({ topic, text: z.string().min(1).max(PREFERENCE_TEXT_MAX) })).max(20).optional(),
      change: z.array(z.object({
        id: z.number().int().positive(),
        topic: topic.optional(),
        text: z.string().min(1).max(PREFERENCE_TEXT_MAX).optional(),
      })).max(20).optional().describe("New words or another topic for saved preferences, by id"),
      remove: z.array(z.number().int().positive()).max(50).optional().describe("Ids of preferences the user wants gone"),
    }),
    kind: "write",
  }, async (args) => {
    if (!args.add?.length && !args.change?.length && !args.remove?.length) fail("Nothing to change: pass add, change or remove.");
    try {
      const r = await changePreferences(args, "agent");
      const lines = [
        ...r.added.map((p) => `Added [${p.id}] under ${p.topic}: ${p.text}`),
        ...r.changed.map((p) => `Changed [${p.id}] under ${p.topic}: ${p.text}`),
        ...r.removed.map((p) => `Removed [${p.id}]: ${p.text}`),
        ...r.kept.map((t) => `Saved already: ${t}`),
      ];
      return lines.length ? lines.join("\n") : "Nothing changed: the preferences say that already.";
    } catch (e) {
      if (e instanceof PreferenceProblem) fail(e.message);
      throw e;
    }
  });
}
