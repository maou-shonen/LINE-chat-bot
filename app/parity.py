"""Legacy check() ported faithfully as the full-scan parity reference.

Copied from handler.EventText.check semantics: the winner selection,
level ranking, random tie order, 全回應 path (leading @ exclusion,
single-char reply exclusion), and the first/last-char pin quirk.
Kept in sync with app/handler.py by tests/test_parity_vs_handler.py,
which runs both against the same synthetic keyword set.
"""
import random as random_module


def legacy_check(message, rows, all_reply=False, group=None,
                 session=None, full_image=True):
    from app.db import UserSettings
    exclude_url = all_reply and not (
        not group or UserSettings.get(
            session, group.id, None, "全圖片", default=False)
        if session is not None and full_image else full_image)

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
                return row_reply
        elif row.keyword.replace("**", "") == message:
            result.append(row_reply)
        elif not all_reply or len(row_reply) > 1:
            keys.append((row.keyword, row_reply))

    if len(result) > 0:
        return random_module.choice(result)

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
        return random_module.choice(results[result_level])

    return None
