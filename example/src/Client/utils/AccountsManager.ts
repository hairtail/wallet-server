import { EventEmitter } from "events";

import {
  generateKeyFromPrivateKey,
  Key,
  NoteEncrypted,
  Note,
} from "@ironfish/rust-nodejs";
import { BlockCache } from "./BlockCache";
import {
  LightBlock,
  LightSpend,
  LightTransaction,
} from "../../../../src/models/lightstreamer";
import { logThrottled } from "./logThrottled";

export interface DecryptedNoteValue {
  accountId: string;
  note: Note;
  spent: boolean;
  transactionHash: Buffer;
  index: number;
  nullifier: Buffer;
  blockHash: Buffer;
  sequence: number;
}

/* Note hash => DecryptedNoteValue */
type AssetNotesByNoteHash = Map<Buffer, DecryptedNoteValue>;

/* Asset ID => AssetNotesByNoteHash */
type AssetContentByAssetId = Map<Buffer, AssetNotesByNoteHash>;

interface AccountData {
  key: Key;
  head: number;
  assets: AssetContentByAssetId;
  /**
   * The following items, `noteHashByNullifier` and `assetIdByNoteHash`, are used when processing spends.
   * Since all we have are the nullifiers, we first get the note hash from `noteHashByNullifier` and then we
   * get its asset id from `assetIdByNoteHash`. We can then get the note from the asset content and mark it as spent.
   */
  /** Nullifier => Note hash */
  noteHashByNullifier: Map<Buffer, Buffer>;
  /** Note hash => Asset ID */
  assetIdByNoteHash: Map<Buffer, Buffer>;
}

export class AccountsManager {
  private blockCache: BlockCache;
  /** Public key => AccountData */
  private accounts: Map<string, AccountData> = new Map();
  private events: EventEmitter = new EventEmitter();

  constructor(blockCache: BlockCache) {
    this.blockCache = blockCache;
  }

  public addAccount(privateKey: string) {
    const accountData = this._makeAccountData(privateKey);
    this.accounts.set(...accountData);

    this.blockCache
      .createReadStream()
      .on("data", ({ key, value }: { key: string; value: Buffer }) => {
        const sequenceKey = this.blockCache.decodeKey(key);
        if (!sequenceKey) {
          return;
        }
        this._processBlockForTransactions(value);
        this.events.emit("accounts-updated");
      });

    return accountData[0];
  }

  public waitForAccountSync(
    publicAddress: string,
    sequence: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const checkSequence = () => {
        const accountData = this.accounts.get(publicAddress);
        if (!accountData) {
          this.events.removeListener("accounts-updated", checkSequence);
          return reject(
            new Error(`Account with public address ${publicAddress} not found`),
          );
        }
        logThrottled(
          `Waiting for account sync to complete, ${accountData.head}/${sequence}`,
          1000,
          accountData.head,
        );
        if (accountData.head >= sequence) {
          this.events.removeListener("accounts-updated", checkSequence);
          return resolve();
        }
      };

      // Check initially
      checkSequence();

      // Listen for account updates
      this.events.on("accounts-updated", checkSequence);
    });
  }

  public getPublicAddresses() {
    return Array.from(this.accounts.keys());
  }

  public getAssetValuesForAccount(publicKey: string) {
    const account = this.accounts.get(publicKey);

    if (!account) {
      return null;
    }

    const assetValues: { [assetId: string]: number } = {};

    for (const [assetId, assetContent] of account.assets) {
      const notes = Array.from(assetContent.values());
      const value = notes.reduce((a, b) => a + b.note.value(), 0n);
      assetValues[assetId.toString("hex")] = Number(value);
    }

    return assetValues;
  }

  public async handleReorg(invalidBlocks: LightBlock[]) {
    invalidBlocks.forEach((block) => {
      this._handleBlockReorg(block);
    });
  }

  private _makeAccountData(privateKey: string): [string, AccountData] {
    const key = generateKeyFromPrivateKey(privateKey);
    return [
      key.publicAddress,
      {
        key,
        head: 0,
        assets: new Map(),
        assetIdByNoteHash: new Map(),
        noteHashByNullifier: new Map(),
      },
    ];
  }

  private _processBlockForTransactions(block: Buffer) {
    const parsedBlock = LightBlock.decode(block);
    const totalNotesInBlock = parsedBlock.transactions
      .map((tx) => tx.outputs.length)
      .reduce((a, b) => a + b, 0);
    const prevBlockNoteSize = parsedBlock.noteSize - totalNotesInBlock;

    let currentNotePosition = 0;

    parsedBlock.transactions.forEach((tx) => {
      tx.outputs.forEach((output, index) => {
        const position = prevBlockNoteSize + currentNotePosition;
        currentNotePosition++;

        this._processNote(
          new NoteEncrypted(output.note),
          parsedBlock,
          tx,
          index,
          position,
        );
      });

      tx.spends.forEach((spend) => {
        this._processSpend(spend);
      });
    });

    for (const [_, account] of this.accounts) {
      account.head = parsedBlock.sequence;
    }
  }

  private _processNote(
    note: NoteEncrypted,
    block: LightBlock,
    tx: LightTransaction,
    index: number,
    position: number,
  ) {
    for (const publicKey of this.accounts.keys()) {
      // Get account data for public key
      const account = this.accounts.get(publicKey);
      if (!account) return;

      // Decrypt note using view key
      const decryptedNoteBuffer = note.decryptNoteForOwner(
        account.key.incomingViewKey,
      );

      // If no result, note is not for this account
      if (!decryptedNoteBuffer) return;

      const foundNote = Note.deserialize(decryptedNoteBuffer);

      // Get asset id and amount for note
      const assetId = foundNote.assetId();

      // If asset id does not exist, create it
      if (!account.assets.has(assetId)) {
        account.assets.set(assetId, new Map());
      }

      const assetContent = account.assets.get(assetId)!;

      const nullifier = foundNote.nullifier(
        account.key.viewKey,
        BigInt(position),
      );

      account.assetIdByNoteHash.set(foundNote.hash(), assetId);
      account.noteHashByNullifier.set(nullifier, foundNote.hash());

      // Register note
      assetContent.set(foundNote.hash(), {
        accountId: publicKey,
        note: foundNote,
        spent: false,
        transactionHash: tx.hash,
        index,
        nullifier,
        blockHash: block.hash,
        sequence: block.sequence,
      });

      logThrottled(
        `Account ${publicKey} has ${assetContent.size} notes for asset ${assetId}`,
        10,
        assetContent.size,
      );
    }
  }

  private _processSpend(spend: LightSpend) {
    for (const account of this.accounts.values()) {
      const noteHash = account.noteHashByNullifier.get(spend.nf);

      if (!noteHash) return;

      const assetId = account.assetIdByNoteHash.get(noteHash);

      if (!assetId) return;

      const note = account.assets.get(assetId)?.get(noteHash);

      if (!note) return;

      account.assetIdByNoteHash.delete(noteHash);
      account.noteHashByNullifier.delete(spend.nf);
      note.spent = true;
    }
  }

  private _handleBlockReorg(block: LightBlock) {
    // To process a reorg for a block, we need to undo what spends and outputs normally do.
    // For spends, we need to mark the note as unspent and update the appropriate mappings.
    // For outputs, we need to remove the note.

    // We have to process reorg'd blocks for each account
    for (const [_, account] of this.accounts) {
      block.transactions.forEach((tx) => {
        // First we'll process spends
        tx.spends.forEach((spend) => {
          // If we have a note hash for the nullifier, it means we have a note for this account.
          const noteHash = account.noteHashByNullifier.get(spend.nf);

          if (!noteHash) return;

          // If we found a note hash, the following should exist.
          const assetId = account.assetIdByNoteHash.get(noteHash);
          const assetContent = assetId && account.assets.get(assetId);
          const decryptedNote = assetContent && assetContent.get(noteHash);

          if (!assetId || !assetContent || !decryptedNote) return;

          // Since we're undoing a spend, we need to update the mappings,
          // and mark the note as unspent.
          account.assetIdByNoteHash.set(noteHash, assetId);
          account.noteHashByNullifier.set(decryptedNote.nullifier, noteHash);
          decryptedNote.spent = false;
        });

        // Next we'll process outputs
        tx.outputs.forEach((output) => {
          const note = new NoteEncrypted(output.note);

          // Decrypt note using view key
          const decryptedNoteBuffer = note.decryptNoteForOwner(
            account.key.incomingViewKey,
          );

          // If the note could not be decrypted, it's not for this account.
          if (!decryptedNoteBuffer) {
            return;
          }

          const deserializedNote = Note.deserialize(decryptedNoteBuffer);
          const noteHash = deserializedNote.hash();
          const assetContent = account.assets.get(deserializedNote.assetId());
          const storedNote = assetContent && assetContent.get(noteHash);

          // If the asset does not exist, or the note is not registered, we can continue.
          if (!assetContent || !storedNote) {
            return;
          }

          // Finally, we can remove the lookup mappings, and delete the note.
          account.noteHashByNullifier.delete(storedNote.nullifier);
          account.assetIdByNoteHash.delete(noteHash);
          assetContent.delete(noteHash);
        });
      });
    }
  }
}
