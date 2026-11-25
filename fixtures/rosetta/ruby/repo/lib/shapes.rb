module Shape
  def area
    raise NotImplementedError
  end
end

class Circle
  include Shape

  def initialize(radius)
    @radius = radius
  end

  def area
    3 * @radius * @radius
  end
end

class Square
  include Shape

  def initialize(side)
    @side = side
  end

  def area
    @side * @side
  end
end

def total(shapes)
  shapes.sum { |s| s.area }
end

def circle_area
  Circle.new(1).area
end
