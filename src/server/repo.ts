import "server-only";
import { noteSessionEvent } from "./attention";
import { isAttention } from "@/lib/dates";
import { usesCloud } from "./scope";
import * as cloud from "./store/cloud";
import * as local from "./store/local";

/*
 * The app's data: the signed-in account's in PacedMind Cloud (store/cloud.ts), or without an account this
 * computer's own (store/local.ts, the free One device plan). Both answer every call the same way, so the rest
 * of the app never asks which one it has; each call goes to the one in use at that moment (scope.ts).
 */

export {
  CODEX_ENV, DEFAULT_SETTINGS, cleanDeviceName, cleanDoneWhen, codexEnvProblem, repoOf,
  type AskInput, type FolderRequestInput, type LaunchRequestFilter, type LaunchRequestInput, type PushSubscriptionRow, type ReportInput, type SessionFilter,
  type TaskFilter, type TaskInput, type TaskPatch,
} from "./store/shared";

type Store = typeof cloud;

// This computer's store must answer everything the account's does, with the same types.
const stores: { cloud: Store; local: Store } = { cloud, local };

export const getTaskNoteDisplays = via("getTaskNoteDisplays");
export const saveTaskNoteDisplays = via("saveTaskNoteDisplays");
export const listTaskNoteRequests = via("listTaskNoteRequests");
export const createTaskNoteRequest = via("createTaskNoteRequest");
export const settleTaskNoteRequest = via("settleTaskNoteRequest");

/** A store function that runs on whichever store is in use when it's called. */
function via<K extends keyof Store>(name: K): Store[K] {
  const call = async (...args: unknown[]) => {
    const store = (await usesCloud()) ? stores.cloud : stores.local;
    return (store[name] as (...a: unknown[]) => Promise<unknown>)(...args);
  };
  return call as unknown as Store[K];
}

/* ---------- areas and projects ---------- */
export const listAreas = via("listAreas");
export const areaPicture = via("areaPicture");
export const createArea = via("createArea");
export const updateArea = via("updateArea");
export const deleteArea = via("deleteArea");
export const listProjects = via("listProjects");
export const getProject = via("getProject");
export const createProject = via("createProject");
export const updateProject = via("updateProject");
export const deleteProject = via("deleteProject");
export const setProjectRepo = via("setProjectRepo");
export const setAreaRepo = via("setAreaRepo");
export const mergeProject = via("mergeProject");

/* ---------- tasks ---------- */
export const listTasks = via("listTasks");
export const getTask = via("getTask");
export const createTask = via("createTask");
export const updateTask = via("updateTask");
export const deleteTask = via("deleteTask");
export const addSubtask = via("addSubtask");
export const setSubtaskDone = via("setSubtaskDone");
export const deleteSubtask = via("deleteSubtask");

/* ---------- calendar events ---------- */
export const listEvents = via("listEvents");
export const createEvent = via("createEvent");
export const getEvent = via("getEvent");
export const updateEvent = via("updateEvent");
export const deleteEvent = via("deleteEvent");
export const setEventDone = via("setEventDone");
export const occurrences = via("occurrences");

/* ---------- sessions ---------- */
export const listSessions = via("listSessions");
export const getSession = via("getSession");
export const latestSession = via("latestSession");
export const createSession = via("createSession");
export const updateSession = via("updateSession");
const addEvent = via("addSessionEvent");
/** Adds to a session's history. Every event goes through here, so what the session waits for you about stays current (attention.ts). */
export async function addSessionEvent(sessionId: string, kind: string, text = "") {
  await addEvent(sessionId, kind, text);
  noteSessionEvent(sessionId, kind);
  // The moments a session needs you reach your other devices too (push.ts, which uses this module: loaded when needed).
  if (isAttention(kind) || kind === "finished") void import("./push").then((m) => m.pushEvent(sessionId, kind, text)).catch(() => {});
}
export const sessionEvents = via("sessionEvents");
export const sessionEventsFor = via("sessionEventsFor");
export const doneTimes = via("doneTimes");

/* ---------- reports and their images ---------- */
export const countSessionImages = via("countSessionImages");
export const attachmentFile = via("attachmentFile");
export const addAttachment = via("addAttachment");
export const pendingImages = via("pendingImages");
export const createReport = via("createReport");
export const setReportChanges = via("setReportChanges");
export const deleteReport = via("deleteReport");
export const reportsForTasks = via("reportsForTasks");
export const reportBriefs = via("reportBriefs");
export const reportsForSessions = via("reportsForSessions");
export const latestReport = via("latestReport");
export const latestSessionReport = via("latestSessionReport");
export const heldOutcomes = via("heldOutcomes");

/* ---------- dependencies (the Timeline's arrows) ---------- */
export const listEdges = via("listEdges");
export const createEdge = via("createEdge");
export const deleteEdge = via("deleteEdge");

/* ---------- settings, and preferences for agents ---------- */
export const getSettings = via("getSettings");
export const setSettings = via("setSettings");
export const listPreferences = via("listPreferences");
export const addPreference = via("addPreference");
export const updatePreference = via("updatePreference");
export const deletePreference = via("deletePreference");

/* ---------- computers and requests to start sessions (PacedMind Cloud's) ---------- */
export const saveDeviceTools = via("saveDeviceTools");
export const listDevices = via("listDevices");
export const getDevice = via("getDevice");
export const registerDevice = via("registerDevice");
export const claimDevice = via("claimDevice");
export const revokeDevice = via("revokeDevice");
export const renameDevice = via("renameDevice");
export const setDefaultDevice = via("setDefaultDevice");
export const updateDeviceRow = via("updateDeviceRow");
export const listLaunchRequests = via("listLaunchRequests");
export const createLaunchRequest = via("createLaunchRequest");
export const settleLaunchRequest = via("settleLaunchRequest");
export const createFolderRequest = via("createFolderRequest");
export const listFolderRequests = via("listFolderRequests");
export const settleFolderRequest = via("settleFolderRequest");

/* ---------- what a running session waits for you to answer (asks.ts), and web push (push.ts) ---------- */
export const createAsk = via("createAsk");
export const getAsk = via("getAsk");
export const listAsks = via("listAsks");
export const answerAsk = via("answerAsk");
export const settleAsk = via("settleAsk");
export const pushKeys = via("pushKeys");
export const savePushKeys = via("savePushKeys");
export const listPushSubscriptions = via("listPushSubscriptions");
export const addPushSubscription = via("addPushSubscription");
export const removePushSubscription = via("removePushSubscription");

/* ---------- agents signed in to PacedMind Cloud's MCP server ---------- */
export const listConnectedAgents = via("listConnectedAgents");
export const disconnectAgent = via("disconnectAgent");

/* ---------- live refresh ---------- */
export const stateVersion = via("stateVersion");
