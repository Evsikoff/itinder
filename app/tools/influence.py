"""Влияние узлов системного дизайна на программируемые узлы.

Решения (element_instances.behaviors) и виды связей (link_types.behaviors)
порождают поведения. Каждое поведение относится к каналу влияния
(influence_channels): канал задаёт, по каким связям и в какую сторону
поведение распространяется и сквозь какие типы элементов проходит насквозь.
Первый непрозрачный для канала программируемый узел на пути обязан учесть
поведение — он и считается подверженным влиянию.

Запуск из корня проекта:
    python app/tools/influence.py > app/reports/influence_report.md
"""

import json
import sys
from collections import defaultdict, deque
from dataclasses import dataclass
from math import prod
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "db"
MAX_K = 3  # до скольких одновременно влияющих узлов считать варианты задач
TARGET_TYPES = ("service", "worker", "workflow_engine", "ui")


def load(name):
    return json.loads((DB / name).read_text(encoding="utf-8"))


class Catalog:
    def __init__(self):
        self.types = {r["id"]: r for r in load("element_types.json")}
        self.link_types = {r["id"]: r for r in load("link_types.json")}
        self.instances = {r["id"]: r for r in load("element_instances.json")}
        self.channels = {r["id"]: r for r in load("influence_channels.json")}
        self.behaviors = {r["id"]: r for r in load("behaviors.json")}
        self.designs = load("designs.json")
        self.structures = {r["design_id"]: r for r in load("design_structures.json")}
        self.carriers = {
            c["id"]: {(x["link_type_id"], x["direction"]) for x in c["carriers"]}
            for c in self.channels.values()
        }
        self.transparent = {c["id"]: set(c["transparent_types"]) for c in self.channels.values()}
        self.by_type = defaultdict(list)
        for inst in self.instances.values():
            self.by_type[inst["type_id"]].append(inst)
        # Какие каналы вообще может породить элемент данного типа.
        self.type_channels = defaultdict(set)
        for inst in self.instances.values():
            for b in inst["behaviors"]:
                self.type_channels[inst["type_id"]].add(self.channel_of(b))

    def channel_of(self, behavior_id):
        return self.behaviors[behavior_id]["channel_id"]


@dataclass
class Influence:
    behavior: str
    path: list            # от источника до узла, который обязан учесть поведение
    link: dict | None = None  # если источник — связь, а не решение в узле

    @property
    def distance(self):
        return len(self.path) - 1

    @property
    def adjacent(self):
        return self.distance <= 1


class Design:
    """Граф одного дизайна с конкретными решениями в узлах."""

    def __init__(self, cat, design_id):
        self.cat = cat
        self.meta = next(d for d in cat.designs if d["id"] == design_id)
        structure = cat.structures[design_id]
        self.links = structure["links"]
        self.instance = {n["id"]: cat.instances[n["instance_id"]] for n in structure["nodes"]}
        self.nodes = list(self.instance)

    def type_of(self, node):
        return self.instance[node]["type_id"]

    def programmable(self, node):
        return self.instance[node]["programmable"]

    def _next(self, node, channel):
        carriers = self.cat.carriers[channel]
        for link in self.links:
            kind = link["link_type_id"]
            if link["from"] == node and (kind, "forward") in carriers:
                yield link["to"]
            if link["to"] == node and (kind, "backward") in carriers:
                yield link["from"]

    def spread(self, path, channel):
        """{узел: путь} для узлов, которые обязаны учесть поведение канала,
        возникшее в конце path.

        Прозрачные для канала узлы пропускают влияние дальше, непрозрачные
        останавливают; влияние засчитывается, только если остановивший узел
        программируемый — остальные учесть его не могут.
        """
        transparent = self.cat.transparent[channel]
        hits, seen = {}, set(path)
        queue = deque([path])
        while queue:
            current = queue.popleft()
            for nxt in self._next(current[-1], channel):
                if nxt in seen:
                    continue
                seen.add(nxt)
                step = current + [nxt]
                if self.type_of(nxt) in transparent:
                    queue.append(step)
                elif self.programmable(nxt):
                    hits[nxt] = step
        return hits

    def spread_from_link(self, link, channel):
        """Поведение связи возникает на её конце `to`."""
        path, end = [link["from"], link["to"]], link["to"]
        if self.type_of(end) in self.cat.transparent[channel]:
            return self.spread(path, channel)
        return {end: path} if self.programmable(end) else {}

    def influences(self):
        """{узел: [Influence]} для решений, которые сейчас стоят в узлах."""
        result = defaultdict(list)
        for node in self.nodes:
            for b in self.instance[node]["behaviors"]:
                channel = self.cat.channel_of(b)
                if self.cat.channels[channel]["affects_self"] and self.programmable(node):
                    result[node].append(Influence(b, [node]))
                for target, path in self.spread([node], channel).items():
                    result[target].append(Influence(b, path))
        for link, b in self.link_behaviors():
            for target, path in self.spread_from_link(link, self.cat.channel_of(b)).items():
                result[target].append(Influence(b, path, link))
        return result

    def link_behaviors(self):
        for link in self.links:
            for b in self.cat.link_types[link["link_type_id"]]["behaviors"]:
                yield link, b

    def options(self, target):
        """Варианты влияния на target при переборе решений в остальных узлах.

        {узел: множество различных непустых наборов поведений, которые решения
        его типа способны донести до target}. Пути зависят только от типов
        узлов, поэтому узлы можно перебирать независимо.
        """
        result = {}
        for node in self.nodes:
            if node == target:
                continue
            reach = {ch for ch in self.cat.type_channels[self.type_of(node)]
                     if target in self.spread([node], ch)}
            sets = {frozenset(b for b in inst["behaviors"] if self.cat.channel_of(b) in reach)
                    for inst in self.cat.by_type[self.type_of(node)]}
            sets.discard(frozenset())
            if sets:
                result[node] = sets
        return result

    def naive_combinations(self):
        return prod(len(self.cat.by_type[self.type_of(n)]) for n in self.nodes)


def elementary(counts, k_max):
    """e[k] — число способов выбрать k влияющих узлов и по варианту в каждом."""
    e = [1] + [0] * k_max
    for m in counts:
        for k in range(k_max, 0, -1):
            e[k] += e[k - 1] * m
    return e


def fmt(n):
    return f"{n:,}".replace(",", " ")


def report(cat):
    out = []
    w = out.append
    designs = [Design(cat, d["id"]) for d in cat.designs]
    bname = lambda b: cat.behaviors[b]["name"]
    tname = lambda t: cat.types[t]["name"]

    def label(d, node):
        return f"{node} ({d.instance[node]['name']})"

    def source(d, inf):
        if inf.link:
            return f"связь {inf.link['from']} → {inf.link['to']} ({cat.link_types[inf.link['link_type_id']]['name']})"
        return label(d, inf.path[0])

    w("# Влияние узлов на программируемые узлы\n")
    w("Отчёт построен `app/tools/influence.py` по данным `app/db`. "
      "Влияние — поведение элемента, которое программируемый узел обязан учесть в своём коде.\n")

    # 1. Текущие дизайны
    w("## 1. Текущие дизайны\n")
    w("| Дизайн | Сложн. | Программируемых узлов | Под влиянием соседей | Под влиянием несоседних узлов |")
    w("|---|---|---|---|---|")
    for d in designs:
        inf = d.influences()
        prog = [n for n in d.nodes if d.programmable(n)]
        near = sorted(n for n, xs in inf.items() if any(x.distance == 1 for x in xs))
        far = sorted(n for n, xs in inf.items() if any(x.distance >= 2 for x in xs))
        w(f"| {d.meta['id']} | {d.meta['complexity']} | {len(prog)} | {', '.join(near) or '—'} | {', '.join(far) or '—'} |")
    w("")

    # 2. Несоседние влияния на уровне типов
    w("## 2. Кто влияет не через соседа\n")
    w("Все пути длиной от двух связей, которые возможны в текущих схемах при подходящем выборе решений.\n")
    patterns = defaultdict(set)
    for d in designs:
        for node in d.nodes:
            for ch in cat.type_channels[d.type_of(node)]:
                for target, path in d.spread([node], ch).items():
                    if len(path) > 2:
                        key = (tname(d.type_of(node)), ch, tuple(tname(d.type_of(n)) for n in path[1:-1]), tname(d.type_of(target)))
                        patterns[key].add(d.meta["id"][:3])
        for link, b in d.link_behaviors():
            for target, path in d.spread_from_link(link, cat.channel_of(b)).items():
                if len(path) > 2:
                    key = ("связь: " + cat.link_types[link["link_type_id"]]["name"], cat.channel_of(b),
                           tuple(tname(d.type_of(n)) for n in path[1:-1]), tname(d.type_of(target)))
                    patterns[key].add(d.meta["id"][:3])
    w("| Источник | Канал | Через | На кого | Дизайны |")
    w("|---|---|---|---|---|")
    for (src, ch, via, dst), ds in sorted(patterns.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        w(f"| {src} | {cat.channels[ch]['name']} | {' → '.join(via)} | {dst} | {', '.join(sorted(ds))} |")
    w("")

    # 3. Разнообразие задач
    w("## 3. Сколько разных задач\n")
    w(f"Цели — узлы типов: {', '.join(tname(t) for t in TARGET_TYPES)}. "
      "**Влияющих узлов** — сколько узлов схемы могут повлиять на цель при подходящем решении. "
      "**k = 1…3** — сколько различных по сути задач, если влияют ровно k узлов: "
      "в каждом выбран один из различных наборов поведений, которые его решения доносят до цели. "
      "Влияние связей (webhook, репликация, CDC, push) постоянно и в подсчёт не входит. "
      "**Все комбинации** — перебор всех решений во всех узлах, без учёта сути.\n")
    w("| Дизайн | Цель | Влияющих узлов | k = 1 | k = 2 | k = 3 | Все комбинации |")
    w("|---|---|---|---|---|---|---|")
    totals = defaultdict(lambda: [0] * (MAX_K + 1))
    naive_total = 0
    for d in designs:
        naive_total += d.naive_combinations()
        for target in d.nodes:
            if d.type_of(target) not in TARGET_TYPES or not d.programmable(target):
                continue
            opts = d.options(target)
            e = elementary([len(s) for s in opts.values()], MAX_K)
            for k in range(1, MAX_K + 1):
                totals[d.meta["complexity"]][k] += e[k]
            w(f"| {d.meta['id']} | {target} ({tname(d.type_of(target))}) | {len(opts)} | "
              + " | ".join(fmt(e[k]) for k in range(1, MAX_K + 1)) + f" | {fmt(d.naive_combinations())} |")
    w("")
    w("Итого по сложности схем:\n")
    w("| Сложность схемы | k = 1 | k = 2 | k = 3 |")
    w("|---|---|---|---|")
    for cx in sorted(totals):
        w(f"| {cx} | " + " | ".join(fmt(totals[cx][k]) for k in range(1, MAX_K + 1)) + " |")
    all_k = [sum(t[k] for t in totals.values()) for k in range(MAX_K + 1)]
    w(f"| **Всего** | " + " | ".join(f"**{fmt(all_k[k])}**" for k in range(1, MAX_K + 1)) + " |")
    w(f"\nДля сравнения: все комбинации решений по всем дизайнам — {fmt(naive_total)}.\n")

    # 4. Нейтральные решения
    w("## 4. Нейтральные решения для связующих узлов\n")
    w("Решения без собственных поведений: в связующем узле они не добавляют влияний.\n")
    w("| Тип | Нейтральных | Всего | Решения |")
    w("|---|---|---|---|")
    for t in cat.types:
        neutral = [i["name"] for i in cat.by_type[t] if not i["behaviors"]]
        w(f"| {tname(t)} | {len(neutral)} | {len(cat.by_type[t])} | {', '.join(neutral) or '—'} |")
    w("")

    # 5. Подробно
    w("## 5. Подробно по текущим дизайнам\n")
    for d in designs:
        inf = d.influences()
        w(f"### {d.meta['id']} — {d.meta['name']}\n")
        if not inf:
            w("Влияний нет: все решения в схеме нейтральные.\n")
        for node in d.nodes:
            if node not in inf:
                continue
            w(f"**{label(d, node)}**\n")
            for x in sorted(inf[node], key=lambda x: x.distance):
                if x.distance == 0:
                    where = "сам узел"
                elif x.distance == 1:
                    where = f"сосед: {source(d, x)}"
                else:
                    where = f"несоседний: {source(d, x)}, путь {' → '.join(x.path)}"
                w(f"- {bname(x.behavior)} — {where}. *{cat.behaviors[x.behavior]['requirement']}*")
            w("")
    return "\n".join(out)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print(report(Catalog()))
