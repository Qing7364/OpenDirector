"""Official MiniMax Video V2 model output contracts."""
MINIMAX_MODELS = {
    'MiniMax-H3': (('768P', '2K'), 4),
    'MiniMax-H3-Highspeed': (('480P', '768P'), 4),
    'MiniMax-H3-Lite': (('480P', '768P'), 4),
    'MiniMax-H3-Max': (('480P', '768P'), 5),
}


def minimax_capabilities(model_id):
    resolutions, minimum = MINIMAX_MODELS[model_id]
    return {'outputs': [{'resolution': label, 'durations': list(range(minimum, 16))} for label in resolutions],
            'defaultResolution': '768P', 'defaultDuration': 5, 'dimensionStep': 2}
