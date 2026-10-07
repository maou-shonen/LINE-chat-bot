"""Legacy check() ported faithfully as the full-scan parity reference.

Copied from handler.EventText.check semantics: the winner selection,
level ranking, random tie order, 全回應 path (leading @ exclusion,
single-char reply exclusion), and the first/last-char pin quirk.
Kept in sync with app/handler.py by tests/test_keywords.py, which
asserts check() source still carries the split('**') loop and no
anchor reference.
"""
import random as random_module


def winning_set(message, rows, all_reply=True, exclude_url=False):
    """Full candidate WINNING set (before the seeded random choice).

    Returns the exact-match list when non-empty, else the top-level
    list, else []. Mirrors legacy_check below without consuming
    random state, so parity compares sets, not one random draw.
    """
    keys = []
    result = []

    for row in rows:
        row_reply = row.reply

        if row_reply[:1] == "@":
            if all_reply:
                continue
            else:
                row_reply = row.reply[1:]

        if exclude_url and "https:" in row_reply:
            continue

        if row.keyword == message:
            if all_reply:
                result.append(row_reply)
            else:
                return [row_reply]
        elif row.keyword.replace("**", "") == message:
            result.append(row_reply)
        elif not all_reply or len(row_reply) > 1:
            keys.append((row.keyword, row_reply))

    if len(result) > 0:
        return sorted(result)

    results = {}
    result_level = -99
    for k, v in keys:
        kn = -1
        k_arr = k.split("**")
        for k2 in k_arr:
            if k2 != "":
                n = message.find(k2)
                if n > kn:
                    kn = n
                else:
                    break
            if k_arr[0] != "" and message[0] != k[0]:
                break
            if k_arr[-1] != "" and message[-1] != k[-1]:
                break
        else:
            level = len(k) - k.count("**") - (
                2 if k[:2] == "**" else 0) - (
                2 if k[-2:] == "**" else 0)
            if level not in results:
                results[level] = []
            if level > result_level:
                result_level = level
            results[level].append(v)

    if len(results) > 0:
        return sorted(results[result_level])

    return []


def legacy_check(message, rows, all_reply=False, exclude_url=False):
    win = winning_set(message, rows, all_reply, exclude_url)
    if not win:
        return None
    if not all_reply and len(win) == 1:
        return win[0]
    return random_module.choice(win)
