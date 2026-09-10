import type { WrittenObjectType } from '../api/web-client.js';

/**
 * One library's most recent cloud write, kept until the desktop app is seen to hold it.
 *
 * Only the LATEST write is kept. Zotero syncs a library forward in version order, so a
 * desktop that has the newest write necessarily has the ones before it, and one witness
 * per library keeps this bounded however many items a session creates.
 */
export interface PendingWrite {
  type: WrittenObjectType;
  /** The object the desktop is asked about. */
  key: string;
  /** The write REMOVED the object, so catching up means the desktop no longer has it. */
  removed: boolean;
  /**
   * The desktop's own version for that object immediately BEFORE the write: a number when
   * it already had it, null when it did not, undefined when it could not be asked.
   *
   * This is what separates "the desktop has an object with that key" from "the desktop has
   * THIS write". A create needs only the first (the key was absent and now is not), but an
   * update to an existing item would clear on presence alone, while the desktop still held
   * the old field values. Comparing the desktop's version for the key against its own
   * earlier version stays inside one sequence, which is the only kind of version comparison
   * these two APIs allow.
   */
  before: number | null | undefined;
}

/**
 * Libraries this process has written on the cloud, and has not yet seen the desktop app
 * catch up with.
 *
 * Keyed by an opaque library slot the router computes, because the personal library has two
 * spellings (users/0 on the desktop, users/<id> on the cloud) that must land in one entry.
 */
export class PendingCloudWrites {
  private readonly bySlot = new Map<string, PendingWrite>();

  note(slot: string, write: PendingWrite): void {
    this.bySlot.set(slot, write);
  }

  get(slot: string): PendingWrite | undefined {
    return this.bySlot.get(slot);
  }

  /**
   * Fill in the baseline for a write that is still the pending one. Scoped to the key
   * because the baseline is measured after the entry is recorded: a second write landing in
   * between replaces the entry, and the first write's baseline must not be pasted onto it.
   */
  setBaseline(slot: string, key: string, before: number | null): void {
    const current = this.bySlot.get(slot);
    if (current?.key === key && current.before === undefined) current.before = before;
  }

  clear(slot: string): void {
    this.bySlot.delete(slot);
  }
}
