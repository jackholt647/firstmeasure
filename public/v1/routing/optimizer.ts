/* Route-assignment optimizer for same-day, fixed-start scheduled stops.
 *
 * The problem: N stops with fixed time windows [start, end] and locations,
 * M assignable subjects (users, crews, ...). Assign each stop to a subject so
 * that no subject has overlapping stops, every consecutive pair on a subject's
 * day leaves enough gap for the travel between them, and total travel time is
 * minimized. Because start times are fixed, each subject's visit order is
 * fully determined by time — this is an assignment problem with interval +
 * travel feasibility, not a full TSP.
 *
 * Strategy: regret-2 greedy insertion (assign the stop whose best option is
 * most at risk first), then a relocate/swap local-search pass until no move
 * improves total travel. Deterministic; no wall-clock or randomness.
 *
 * This module is pure: no storage, no event-type vocabulary, no roles. The
 * caller decides which stops/subjects participate and what "travel minutes"
 * means (live matrix, cached, haversine estimate, ...).
 */

export type RoutingStop = {
  id: string;
  start_ms: number;
  end_ms: number;
  /* Subject id this stop is pinned to (locked events keep their assignee). */
  locked_subject_id?: string;
};

export type RoutingSubject = {
  id: string;
};

export type TravelMinutesFn = (fromStopId: string, toStopId: string) => number;

export type RouteLeg = {
  from_stop_id: string;
  to_stop_id: string;
  travel_minutes: number;
  /* Slack between arrival (previous end + travel) and the next start. */
  slack_minutes: number;
};

export type SubjectRoute = {
  subject_id: string;
  stop_ids: string[];
  legs: RouteLeg[];
  travel_minutes: number;
};

export type OptimizeResult = {
  routes: SubjectRoute[];
  unassigned: Array<{ stop_id: string; reason: string }>;
  total_travel_minutes: number;
  improvement_passes: number;
};

/* Each pass applies at most one move, so the cap needs headroom on dense
 * days; passes are cheap (tens of feasibility checks each). */
const MAX_IMPROVEMENT_PASSES = 400;

function sortChrono(stops: RoutingStop[]) {
  return [...stops].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.id.localeCompare(b.id));
}

/* Travel cost of a subject's day: sum of legs between consecutive stops. */
function routeTravel(stops: RoutingStop[], travel: TravelMinutesFn) {
  let total = 0;
  for (let i = 1; i < stops.length; i += 1) total += travel(stops[i - 1]!.id, stops[i]!.id);
  return total;
}

/* A route is feasible when no stops overlap and every gap fits the travel
 * plus the slack margin (estimates run optimistic). Slack affects
 * feasibility only, never the reported travel cost. */
function routeFeasible(stops: RoutingStop[], travel: TravelMinutesFn, slackMinutes = 0) {
  for (let i = 1; i < stops.length; i += 1) {
    const prev = stops[i - 1]!;
    const next = stops[i]!;
    if (next.start_ms < prev.end_ms) return false;
    const gapMinutes = (next.start_ms - prev.end_ms) / 60000;
    if (gapMinutes < travel(prev.id, next.id) + slackMinutes) return false;
  }
  return true;
}

/* Incremental travel cost of adding `stop` to a chronologically kept route,
 * or null when insertion is infeasible. */
function insertionCost(route: RoutingStop[], stop: RoutingStop, travel: TravelMinutesFn, slackMinutes = 0): number | null {
  const merged = sortChrono([...route, stop]);
  if (!routeFeasible(merged, travel, slackMinutes)) return null;
  return routeTravel(merged, travel) - routeTravel(route, travel);
}

export function optimizeRoutes(
  stopsInput: RoutingStop[],
  subjectsInput: RoutingSubject[],
  travel: TravelMinutesFn,
  options: { slackMinutes?: number } = {}
): OptimizeResult {
  const slack = Math.max(0, Number(options.slackMinutes) || 0);
  const subjects = subjectsInput.filter((subject) => subject.id);
  const stops = sortChrono(stopsInput.filter((stop) => stop.id && Number.isFinite(stop.start_ms) && Number.isFinite(stop.end_ms)));
  const routes = new Map<string, RoutingStop[]>(subjects.map((subject) => [subject.id, []]));
  const unassigned: Array<{ stop_id: string; reason: string }> = [];

  /* Pinned stops go in first; an infeasible pin is reported, not silently moved. */
  const free: RoutingStop[] = [];
  for (const stop of stops) {
    const pinned = String(stop.locked_subject_id || "");
    if (!pinned) {
      free.push(stop);
      continue;
    }
    const route = routes.get(pinned);
    if (!route) {
      unassigned.push({ stop_id: stop.id, reason: "locked_subject_not_available" });
      continue;
    }
    if (insertionCost(route, stop, travel, slack) === null) {
      unassigned.push({ stop_id: stop.id, reason: "locked_assignment_infeasible" });
      continue;
    }
    route.push(stop);
    route.sort((a, b) => a.start_ms - b.start_ms);
  }

  /* Regret-2 insertion: repeatedly place the stop that would lose the most if
   * it doesn't get its best subject now. */
  const pending = new Set(free);
  while (pending.size) {
    let chosen: RoutingStop | null = null;
    let chosenSubject = "";
    let chosenCost = 0;
    let bestRegret = -1;
    for (const stop of pending) {
      let best: { subjectId: string; cost: number } | null = null;
      let secondCost: number | null = null;
      for (const subject of subjects) {
        const cost = insertionCost(routes.get(subject.id)!, stop, travel, slack);
        if (cost === null) continue;
        if (!best || cost < best.cost) {
          secondCost = best ? best.cost : secondCost;
          best = { subjectId: subject.id, cost };
        } else if (secondCost === null || cost < secondCost) {
          secondCost = cost;
        }
      }
      if (!best) continue;
      const regret = secondCost === null ? Number.MAX_SAFE_INTEGER : secondCost - best.cost;
      if (regret > bestRegret || (regret === bestRegret && chosen && stop.start_ms < chosen.start_ms)) {
        bestRegret = regret;
        chosen = stop;
        chosenSubject = best.subjectId;
        chosenCost = best.cost;
      }
    }
    if (!chosen) break;
    void chosenCost;
    pending.delete(chosen);
    const route = routes.get(chosenSubject)!;
    route.push(chosen);
    route.sort((a, b) => a.start_ms - b.start_ms);
  }
  const unplaced = new Set(pending);

  /* Local search: relocate single stops and swap pairs across subjects while
   * total travel keeps dropping. */
  const movable = (stop: RoutingStop) => !stop.locked_subject_id;
  let passes = 0;
  let improved = true;
  while (improved && passes < MAX_IMPROVEMENT_PASSES) {
    improved = false;
    passes += 1;
    for (const [fromId, fromRoute] of routes) {
      for (const stop of [...fromRoute]) {
        if (!movable(stop)) continue;
        const without = fromRoute.filter((item) => item !== stop);
        const removalGain = routeTravel(fromRoute, travel) - routeTravel(without, travel);
        for (const [toId, toRoute] of routes) {
          if (toId === fromId) continue;
          const addCost = insertionCost(toRoute, stop, travel, slack);
          if (addCost === null || addCost >= removalGain - 1e-9) continue;
          routes.set(fromId, without);
          toRoute.push(stop);
          toRoute.sort((a, b) => a.start_ms - b.start_ms);
          improved = true;
          break;
        }
        if (improved) break;
      }
      if (improved) break;
    }
    if (improved) continue;
    /* Placement repair: try to seat an unplaced stop, either directly (a
     * relocate may have opened room) or by ejecting one existing stop to a
     * different subject. Assignment count outranks travel cost. */
    for (const stop of [...unplaced]) {
      let placed = false;
      for (const subject of subjects) {
        const route = routes.get(subject.id)!;
        if (insertionCost(route, stop, travel, slack) === null) continue;
        route.push(stop);
        route.sort((a, b) => a.start_ms - b.start_ms);
        placed = true;
        break;
      }
      if (!placed) {
        eject:
        for (const [hostId, hostRoute] of routes) {
          for (const ejected of hostRoute) {
            if (!movable(ejected)) continue;
            const without = hostRoute.filter((item) => item !== ejected);
            if (insertionCost(without, stop, travel, slack) === null) continue;
            for (const [otherId, otherRoute] of routes) {
              if (otherId === hostId || insertionCost(otherRoute, ejected, travel, slack) === null) continue;
              routes.set(hostId, sortChrono([...without, stop]));
              otherRoute.push(ejected);
              otherRoute.sort((a, b) => a.start_ms - b.start_ms);
              placed = true;
              break eject;
            }
          }
        }
      }
      if (placed) {
        unplaced.delete(stop);
        improved = true;
        break;
      }
    }
    if (improved) continue;
    /* Pairwise swaps between subjects. */
    const entries = [...routes.entries()];
    outer: for (let a = 0; a < entries.length; a += 1) {
      for (let b = a + 1; b < entries.length; b += 1) {
        const [aId, aRoute] = entries[a]!;
        const [bId, bRoute] = entries[b]!;
        for (const stopA of aRoute) {
          if (!movable(stopA)) continue;
          for (const stopB of bRoute) {
            if (!movable(stopB)) continue;
            const nextA = sortChrono([...aRoute.filter((item: RoutingStop) => item !== stopA), stopB]);
            const nextB = sortChrono([...bRoute.filter((item: RoutingStop) => item !== stopB), stopA]);
            if (!routeFeasible(nextA, travel, slack) || !routeFeasible(nextB, travel, slack)) continue;
            const before = routeTravel(aRoute, travel) + routeTravel(bRoute, travel);
            const after = routeTravel(nextA, travel) + routeTravel(nextB, travel);
            if (after >= before - 1e-9) continue;
            routes.set(aId, nextA);
            routes.set(bId, nextB);
            improved = true;
            break outer;
          }
        }
      }
    }
  }

  for (const stop of unplaced) {
    unassigned.push({ stop_id: stop.id, reason: "no_feasible_subject" });
  }

  const resultRoutes: SubjectRoute[] = [];
  let totalTravel = 0;
  for (const [subjectId, route] of routes) {
    const legs: RouteLeg[] = [];
    for (let i = 1; i < route.length; i += 1) {
      const prev = route[i - 1]!;
      const next = route[i]!;
      const minutes = travel(prev.id, next.id);
      legs.push({
        from_stop_id: prev.id,
        to_stop_id: next.id,
        travel_minutes: minutes,
        slack_minutes: Math.round((next.start_ms - prev.end_ms) / 60000 - minutes)
      });
    }
    const travelMinutes = legs.reduce((sum, leg) => sum + leg.travel_minutes, 0);
    totalTravel += travelMinutes;
    resultRoutes.push({
      subject_id: subjectId,
      stop_ids: route.map((stop) => stop.id),
      legs,
      travel_minutes: travelMinutes
    });
  }

  return {
    routes: resultRoutes,
    unassigned,
    total_travel_minutes: totalTravel,
    improvement_passes: passes
  };
}

/* Straight-line distance in kilometers between two coordinates. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}
