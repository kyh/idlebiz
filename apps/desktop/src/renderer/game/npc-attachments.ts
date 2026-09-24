// What rides along with an employee's sprite: the hover label below their feet, the
// "!" / "…" emote and a speech bubble above their head. They follow the sprite every
// frame, the bubble expires, and destroy() frees every object they own.
import { Input } from "phaser";
import type Phaser from "phaser";
import { DEPTH } from "@/renderer/game/config";
import type { Emote } from "@/renderer/game/npc-look";

const EMOTE_FRAME = { alert: 0, think: 1 } satisfies Record<Emote, number>;
/** How long a speech bubble stays up. */
export const BUBBLE_MS = 3200;
/** The hover label hangs below the feet: above the head is where bubbles and emotes live. */
const LABEL_DY = 10;
const EMOTE_DY = -58;
const BUBBLE_DY = -56;

interface Bubble {
  root: Phaser.GameObjects.Container;
  until: number;
}

export class NpcAttachments {
  private readonly scene: Phaser.Scene;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private readonly label: Phaser.GameObjects.Text;
  /** The "!" / "…" above their head, with the bob that lifts it; kept paused while hidden. */
  private emote?: {
    sprite: Phaser.GameObjects.Sprite;
    bob: { dy: number };
    tween: Phaser.Tweens.Tween;
  };
  private bubble?: Bubble;

  constructor(scene: Phaser.Scene, sprite: Phaser.GameObjects.Sprite, caption: string) {
    this.scene = scene;
    this.sprite = sprite;
    const label = scene.add
      .text(sprite.x, sprite.y + LABEL_DY, caption, {
        backgroundColor: "#000000aa",
        color: "#ffffff",
        fontFamily: "monospace",
        fontSize: "10px",
      })
      .setOrigin(0.5, 0)
      .setPadding(3, 1, 3, 1)
      .setDepth(DEPTH.emote)
      .setVisible(false);
    sprite.on(Input.Events.GAMEOBJECT_POINTER_OVER, () => label.setVisible(true));
    sprite.on(Input.Events.GAMEOBJECT_POINTER_OUT, () => label.setVisible(false));
    this.label = label;
  }

  /**
   * Raise an emote, or put it away: hidden and still, since a paused tween costs nothing
   * and a hidden sprite is not moved.
   */
  showEmote(emote: Emote | null): void {
    if (emote === null) {
      if (this.emote) {
        this.emote.sprite.setVisible(false);
        this.emote.tween.pause();
      }
      return;
    }
    const frame = EMOTE_FRAME[emote];
    if (!this.emote) {
      const sprite = this.scene.add
        .sprite(this.sprite.x, this.sprite.y + EMOTE_DY, "emotes", frame)
        .setDepth(DEPTH.emote);
      // the bob is an offset, not the emote's y: the "!" can go up mid-walk
      // (an ask while heading back to the desk) and has to keep up
      const bob = { dy: 0 };
      const tween = this.scene.tweens.add({
        duration: 480,
        dy: -4,
        ease: "Sine.InOut",
        repeat: -1,
        targets: bob,
        yoyo: true,
      });
      this.emote = { bob, sprite, tween };
    }
    this.emote.sprite.setFrame(frame).setVisible(true);
    this.emote.tween.resume();
  }

  say(message: string): void {
    this.bubble?.root.destroy();
    const text = this.scene.add
      .text(0, 0, message.length > 90 ? `${message.slice(0, 87)}…` : message, {
        align: "left",
        color: "#2b2f46",
        fontFamily: "monospace",
        fontSize: "9px",
        wordWrap: { width: 124 },
      })
      .setOrigin(0.5, 1);
    const w = Math.max(34, text.width + 12);
    const h = text.height + 10;
    const g = this.scene.add.graphics();
    g.fillStyle(0xf8_f5_ec, 1).lineStyle(2, 0x1d_21_36, 1);
    g.fillRoundedRect(-w / 2, -h - 4, w, h, 5).strokeRoundedRect(-w / 2, -h - 4, w, h, 5);
    g.fillTriangle(-4, -5, 4, -5, 0, 1).lineStyle(2, 0x1d_21_36, 1);
    text.setY(-9);
    const root = this.scene.add
      .container(this.sprite.x, this.sprite.y + BUBBLE_DY, [g, text])
      .setDepth(DEPTH.emote + 1)
      .setAlpha(0);
    this.scene.tweens.add({ alpha: 1, duration: 140, targets: root });
    this.bubble = { root, until: this.scene.time.now + BUBBLE_MS };
  }

  /** Nothing over their head and no name on hover: they are on their way out. */
  dismiss(): void {
    this.showEmote(null);
    this.label.setVisible(false);
    if (this.bubble) {
      this.bubble.root.destroy();
      this.bubble = undefined;
    }
  }

  /** The label, emote and bubble ride along with the sprite; a bubble also expires. */
  follow(now: number): void {
    const { sprite } = this;
    this.label.setPosition(sprite.x, sprite.y + LABEL_DY);
    const { emote } = this;
    if (emote?.sprite.visible) {
      emote.sprite.setPosition(sprite.x, sprite.y + EMOTE_DY + emote.bob.dy);
    }
    const { bubble } = this;
    if (!bubble) {
      return;
    }
    bubble.root.setPosition(sprite.x, sprite.y + BUBBLE_DY);
    if (now <= bubble.until) {
      return;
    }
    this.bubble = undefined;
    this.scene.tweens.add({
      alpha: 0,
      duration: 180,
      onComplete: () => bubble.root.destroy(),
      targets: bubble.root,
    });
  }

  /** Everything but the sprite they ride on, which is its owner's to destroy. */
  destroy(): void {
    this.emote?.tween.destroy();
    this.bubble?.root.destroy();
    this.emote?.sprite.destroy();
    this.label.destroy();
  }
}
