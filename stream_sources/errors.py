class SourceError(Exception):
    """A safe, user-facing upstream error with an API error code."""

    def __init__(self, code, message, *, status=502):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def public_error(exc):
    if isinstance(exc, SourceError):
        return exc.status, {"error": {"code": exc.code, "message": exc.message}}
    return 500, {"error": {"code": "INTERNAL_ERROR", "message": "サーバー内部でエラーが発生しました"}}
