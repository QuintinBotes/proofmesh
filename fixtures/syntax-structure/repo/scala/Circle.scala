package com.acme.sshapes

import com.acme.geo.{Point, Line}

class Circle extends Base with Shape {
  def area(): Int = {
    import scala.math.Pi
    1
  }
}
