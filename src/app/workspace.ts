import { computed, reactive, ref } from "vue";
import type { Point, Terrain, Session } from "../shared/types";
import { clone, findUnit, key } from "../shared/document";
import { reachable, terrainRules, paintTile } from "../features/terrain";
import { moveBudget, armorValue, tickStatuses } from "../features/roster";
import {
  getSkill,
  legalTargets,
  moveUnit,
  castSkill,
} from "../features/tactics";
import { finishTurn } from "../features/initiative";
import {
  record,
  frame,
  loadArchive,
  saveArchive,
  ArchiveWriteError,
  usePlayback,
} from "../features/replay";
import { newSession } from "./session";

export function useWorkspace() {
  const session = reactive(loadArchive() ?? newSession());
  const cursor = ref(-1),
    selected = ref(session.live.active),
    skill = ref(""),
    brush = ref<Terrain | null>(null),
    notice = ref("选择蓝色格移动，或选择技能指定目标。"),
    failed = ref(false);
  const playback = usePlayback(
    () => session.events.length,
    (n) => {
      cursor.value = n;
    },
  );
  const battle = computed(() => frame(session, cursor.value));
  const actor = computed(() => findUnit(battle.value, battle.value.active));
  const locked = computed(() => cursor.value >= 0 || !!session.live.ended);
  const routes = computed(() =>
    locked.value || actor.value.moved || actor.value.acted
      ? new Map()
      : reachable(session.live, actor.value, moveBudget(actor.value)),
  );
  const targets = computed(() => {
    const s = getSkill(actor.value.job, skill.value);
    return s ? legalTargets(battle.value, actor.value, s) : [];
  });

  function failureNotice(e: unknown) {
    if (e instanceof ArchiveWriteError)
      return (
        `${e.message}，本次操作已回退：地图、生命、行动队列与行动历史` +
        "均保持操作前状态。可先导出原有记录，清理浏览器存储空间后再重试。"
      );
    return (e as Error).message;
  }

  /**
   * 只有在整份会话（战场 + 行动历史）都成功写入存档后，才把改动应用到
   * 界面。任何一步抛错时 draft 会被丢弃，session 保持操作前的完整状态，
   * 因此失败后可安全重试，且不会残留半截事件。
   */
  function commit(
    prepare: (draft: Session) => string,
  ): { label: string; draft: Session } | null {
    // 只复制会被修改的部分：initial 与已有事件都只读，事件通过追加而非
    // 原地修改。失败时 draft 整体丢弃，session 保持操作前状态。
    const draft: Session = {
      initial: session.initial,
      live: clone(session.live),
      events: session.events.slice(),
    };
    try {
      const label = prepare(draft);
      saveArchive(draft);
      return { label, draft };
    } catch (e) {
      notice.value = failureNotice(e);
      failed.value = e instanceof ArchiveWriteError;
      return null;
    }
  }

  function apply(draft: Session, label: string) {
    Object.assign(session, draft);
    notice.value = label;
    failed.value = false;
  }

  function reject(message: string) {
    notice.value = message;
    failed.value = false;
  }

  function cell(p: Point) {
    if (locked.value) {
      reject(
        session.live.ended
          ? "战斗已结束，请重新部署或查看回放"
          : "回放只读，请返回实战",
      );
      return;
    }
    const u = actor.value;
    if (brush.value) {
      const terrain = brush.value;
      const result = commit((draft) => {
        const before = clone(draft.live);
        paintTile(draft.live, p, terrain);
        const label = `地形调整为${terrainRules[terrain].name}`;
        record(draft, before, "terrain", label);
        return label;
      });
      if (result) apply(result.draft, result.label);
    } else if (skill.value) {
      const skillId = skill.value;
      const s = getSkill(u.job, skillId);
      if (!s) {
        reject("请选择合法技能");
        return;
      }
      const result = commit((draft) => {
        const before = clone(draft.live);
        const t = draft.live.units.find(
          (v) => v.hp > 0 && key(v) === key(p),
        );
        if (!t) throw new Error("请点击合法角色");
        const ground = draft.live.tiles.find((v) => key(v) === key(t))!;
        const high =
          draft.live.tiles.find((v) => key(v) === key(u))!.terrain ===
          "ridge";
        const value = castSkill(
          draft.live,
          u.id,
          t.id,
          s,
          armorValue(t),
          terrainRules[ground.terrain].cover,
          high,
        );
        const label = `${u.name} → ${t.name} · ${s.name} ${value}`;
        record(draft, before, "skill", label);
        return label;
      });
      if (result) {
        apply(result.draft, result.label);
        skill.value = "";
      }
    } else {
      const route = routes.value.get(key(p));
      if (!route?.path.length) {
        reject("此格不可达，请检查地形与占位");
        return;
      }
      const result = commit((draft) => {
        const before = clone(draft.live);
        moveUnit(draft.live, u.id, route.path);
        const label = `${u.name}移动 · 消耗${route.cost}`;
        record(draft, before, "move", label, route.path);
        return label;
      });
      if (result) apply(result.draft, result.label);
    }
  }

  function wait() {
    if (locked.value) {
      reject(
        session.live.ended
          ? "战斗已结束，请重新部署或查看回放"
          : "回放只读，请返回实战",
      );
      return;
    }
    const result = commit((draft) => {
      const before = clone(draft.live);
      finishTurn(draft.live, tickStatuses);
      const label = `${findUnit(before, before.active).name}结束行动`;
      record(draft, before, "wait", label);
      return label;
    });
    if (!result) return;
    apply(result.draft, result.label);
    selected.value = session.live.active;
    skill.value = "";
  }

  function seek(n: number) {
    playback.stop();
    cursor.value = n;
    skill.value = "";
    brush.value = null;
  }

  function reset() {
    const result = commit((draft) => {
      Object.assign(draft, newSession());
      return "新战斗已就绪";
    });
    if (!result) return;
    playback.stop();
    apply(result.draft, result.label);
    cursor.value = -1;
    selected.value = session.live.active;
    skill.value = "";
    brush.value = null;
  }

  const path = computed(() =>
    cursor.value > 0 ? (session.events[cursor.value - 1]?.path ?? []) : [],
  );
  return {
    session,
    cursor,
    selected,
    skill,
    brush,
    notice,
    failed,
    battle,
    actor,
    locked,
    routes,
    targets,
    path,
    playback,
    cell,
    wait,
    seek,
    reset,
  };
}
