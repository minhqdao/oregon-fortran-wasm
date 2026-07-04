C     ******************************************************************
C     TIME FUNCTION FOR FORTRAN 90 COMPILERS.
C     ******************************************************************
      INTEGER FUNCTION OREGON_TIME()
      INTEGER IVAL(8)
      CALL DATE_AND_TIME(VALUES=IVAL)
      OREGON_TIME = (IVAL(5) * 3600) + (IVAL(6) * 60) + IVAL(7)
      END
