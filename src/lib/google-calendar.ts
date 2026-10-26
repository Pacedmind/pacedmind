/** Safe status only: never put OAuth credentials or raw provider responses in a component prop. */
export interface GoogleCalendarStatus {
  connections?: GoogleCalendarConnectionStatus[];
  defaultId?: string;
  configured: boolean;
  connected: boolean;
  elsewhere: boolean;
  calendarName?: string;
  lastSync?: string;
  error?: string;
  calendars?: { id: string; name: string; timeZone: string }[];
  conflicts?: { id: string; title: string; fields: string[]; local: CalendarVersion | null; google: CalendarVersion | null }[];
}
export interface CalendarVersion { title: string; start: string; end: string; timeZone: string; description: string; location: string }
export interface CalendarConnectionRow {
  revision: number;
  owner: string;
  payload: string;
  leaseUntil: number;
}

export interface GoogleCalendarConnectionStatus {
  id: string;
  accountName?: string;
  connected: boolean;
  calendarName?: string;
  lastSync?: string;
  error?: string;
  calendars?: { id: string; name: string; timeZone: string }[];
  conflicts?: GoogleCalendarStatus["conflicts"];
}
