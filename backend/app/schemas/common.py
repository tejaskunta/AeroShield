"""AeroShield - shared schema pieces.

A single pagination envelope for every list endpoint. Consistency here is what lets
the Week 6 dashboard write one generic fetch helper instead of one per resource.
"""

from typing import Generic, List, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    """A slice of a larger result set.

    `total` is the count of everything matching the filters, not the length of
    `items` - the client needs it to render "showing 50 of 1,284" and to know
    whether to fetch more.
    """

    items: List[T]
    total: int = Field(description="Total rows matching the filters, ignoring limit/offset")
    limit: int
    offset: int

    @property
    def has_more(self) -> bool:
        return self.offset + len(self.items) < self.total


class Message(BaseModel):
    """Generic acknowledgement for endpoints with nothing better to return."""

    detail: str


class HealthResponse(BaseModel):
    """GET /health - shallow, cheap, and honest about the database."""

    status: str = Field(description="'healthy' only when every dependency is reachable")
    database: str = Field(description="'ok' or 'unreachable'")
    environment: str
    version: str
