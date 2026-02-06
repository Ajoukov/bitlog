import re

curse_words = {
    "nigger",
    "niger",
    "nigga",
    "niga",
    "ni99er",
    "ni9er",
    "ni99a",
    "ni9a"
}


def censor(text: str) -> str:
    text_caps = text
    text = text.lower()
    from_idx = 0
    changed = True
    while changed:
        changed = False
        for cw in curse_words:
            try:
                idx = text.index(cw, from_idx)
            except ValueError:
                continue

            end = idx + len(cw)
            char_before = " " if idx == 0 else text[idx - 1]
            char_after = " " if end >= len(text) else text[end]

            if len(cw) > 4 or (char_before == " " and char_after == " "):
                text = text[:idx] + "***" + text[end:]
                text_caps = text_caps[:idx] + "***" + text_caps[end:]
                from_idx = idx + 1
            else:
                from_idx = end

            changed = True
    return text_caps


# def censor(text: str) -> str:
#   changed = True
#   while changed:
#     changed = False
#     for cw in curse_words:
#       try:
#         idx = text.index(cw)
#         changed = True
#         char_before = ' ' if idx == 0 else text[idx - 1]
#         char_after  = ' ' if idx+len >= len(text) else text[idx+len]
#         if len(cw) > 3 or (char_before != ' ' or char_after != ' '):
#           text = text[:idx] + '***' + text[idx+len(cw):]
#       except err:
#         pass
#   return text
