"""Parser registry. Each parser exposes ``NAME``, ``detect(doc)`` and ``parse(doc)``."""

from . import dealer_history, eldan

PARSERS = (eldan, dealer_history)


def for_doc(doc):
    """The first parser that recognises this document, or None."""
    for parser in PARSERS:
        if parser.detect(doc):
            return parser
    return None
