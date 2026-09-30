/**
 * Emitter event minimal dengan tip yang kuat — dipakai semua modul sistem
 * (mesh room, dsb.) supaya callback listener error tidak saling menjatuhkan.
 */
type AnyListener = (payload: never) => void;

export class Emitter<Events extends object> {
  #listeners = new Map<keyof Events, Set<AnyListener>>();

  /**
   * Mendaftarkan listener untuk sebuah event.
   * @returns fungsi unsubscribe (panggil untuk berhenti mendengarkan).
   */
  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    const existing = this.#listeners.get(event);
    const set = existing ?? new Set<AnyListener>();
    if (existing === undefined) {
      this.#listeners.set(event, set);
    }
    const bound = listener as AnyListener;
    set.add(bound);
    return () => {
      set.delete(bound);
    };
  }

  off<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): void {
    this.#listeners.get(event)?.delete(listener as AnyListener);
  }

  /** Menghapus semua listener semua event. */
  clear(): void {
    this.#listeners.clear();
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (set === undefined) {
      return;
    }
    for (const listener of [...set]) {
      try {
        (listener as unknown as (payload: Events[K]) => void)(payload);
      } catch (error) {
        // Satu listener error tidak boleh memutuskan listener lain. Log hanya
        // ringkasan name+message (remediasi 25-a) — objek error mentah bisa
        // membawa detail internal (stack/properti) yang tidak perlu masuk log.
        const summary = (
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        ).slice(0, 500);
        console.error('[emitter] error pada listener', String(event), summary);
      }
    }
  }
}
