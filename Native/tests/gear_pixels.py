"""Opaque stock snowboard colours, independent of terrain's surface palette."""
def board_pixel(pixel):
    return any(all(abs(c-e) <= 1 for c, e in zip(pixel, colour))
               for colour in ((228, 236, 244), (24, 208, 224)))
