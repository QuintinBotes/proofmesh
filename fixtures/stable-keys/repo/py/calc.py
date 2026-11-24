class C:
    @property
    def x(self):
        return self._x

    @x.setter
    def x(self, value):
        self._x = value
