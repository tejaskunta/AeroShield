"""AeroShield - SQLAlchemy declarative base.

The explicit naming convention is not cosmetic. Without it, PostgreSQL invents
constraint and index names, Alembic autogenerate produces migrations that reference
those invented names, and the same model then generates differently-named
constraints on a teammate's machine. Downgrades break first, then autogenerate
starts emitting spurious drop/create pairs. Setting the convention up front is the
cheapest fix and it has to happen before the first migration.
"""

from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """Declarative base for every AeroShield model."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)
